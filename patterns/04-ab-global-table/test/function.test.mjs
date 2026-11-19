// node --test patterns/04-ab-global-table/test
// Runs the viewer-request function under node with a fake `cloudfront` module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'function.js'), 'utf8')
  .replace(/^import cf from 'cloudfront';\s*/m, '')
  .replace(/^import crypto from 'crypto';\s*/m, '');
const load = (cf) => new Function('cf', 'crypto', `${src}\nreturn handler;`)(cf, crypto);

// Fake KVS: uid -> variant entries, a missing key rejects. Records every key read.
const kvsData = (data) => {
  const reads = [];
  const fn = () => ({ get: async (k) => { reads.push(k); if (!(k in data)) throw new Error('KeyNotFound'); return data[k]; } });
  fn.reads = reads;
  return fn;
};
const noKvs = () => { throw new Error('KVS not associated'); };

// November runtime response shape: status / ok / headers (a Headers object) / promise text().
// text() is a plain function returning a promise, so a missing await would hand JSON.parse a Promise.
const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  bodyUsed: false,
  headers: { get: () => null, has: () => false },
  text: () => Promise.resolve(JSON.stringify(body)),
});
const fetchAssigning = (variant) => {
  const calls = [];
  const fn = async (path, opts) => { calls.push({ path, opts }); return response(200, { variant }); };
  fn.calls = calls;
  return fn;
};
const named = (name, message) => Object.assign(new Error(message), { name });
let seq = 0;
const event = ({ cookies = {}, headers = {} } = {}) => ({
  context: { requestId: 'req-' + seq++ },
  viewer: { ip: '192.0.2.1' },
  request: {
    method: 'GET', uri: '/patterns/ab-global-table/',
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, { value: v }])),
    cookies: Object.fromEntries(Object.entries(cookies).map(([k, v]) => [k, { value: v }])),
    querystring: {},
  },
});
const hv = (out, name) => out.headers[name] && out.headers[name].value;
const UID = '0123456789abcdef';

test('first visit, KVS miss: one fetch, x-ab-set-uid and x-ab-set-variant for the response side', async () => {
  const fetch = fetchAssigning('B');
  const out = await load({ fetch, kvs: kvsData({}) })(event());
  assert.equal(fetch.calls.length, 1);
  const uid = hv(out, 'x-ab-uid');
  assert.match(uid, /^[a-f0-9]{16}$/);
  assert.equal(fetch.calls[0].path, '/assign/' + uid);
  assert.equal(hv(out, 'x-ab-variant'), 'B');
  assert.equal(hv(out, 'x-ab-source'), 'origin');
  assert.equal(hv(out, 'x-ab-set-uid'), uid);
  assert.equal(hv(out, 'x-ab-set-variant'), 'B');
  assert.equal(out.cookies.uid.value, uid, 'the origin sees the new uid as a cookie too');
});

test('cf.fetch called with exactly originId, method, includeBody (no timeout, no body hash)', async () => {
  const fetch = fetchAssigning('A');
  await load({ fetch, kvs: kvsData({}) })(event({ cookies: { uid: UID } }));
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(fetch.calls[0], {
    path: '/assign/' + UID,
    opts: {
      originId: 'ab-global-table',
      method: 'POST',
      includeBody: true,
    },
  });
});

test('new uid never uses Math.random (no network call after random values) and differs per request', async (t) => {
  t.mock.method(Math, 'random', () => { throw new Error('Math.random called before the network call'); });
  const fetch = fetchAssigning('A');
  const a = await load({ fetch, kvs: kvsData({}) })(event());
  const b = await load({ fetch, kvs: kvsData({}) })(event());
  assert.equal(hv(a, 'x-ab-error'), undefined);
  assert.match(hv(a, 'x-ab-uid'), /^[a-f0-9]{16}$/);
  assert.notEqual(hv(a, 'x-ab-uid'), hv(b, 'x-ab-uid'));
});

test('cf.fetch undefined: fails safe to control, TypeError in x-ab-error', async () => {
  const out = await load({ kvs: kvsData({}) })(event({ cookies: { uid: UID } }));
  assert.equal(hv(out, 'x-ab-variant'), 'control');
  assert.match(hv(out, 'x-ab-error'), /not a function/);
});

test('text() returns a promise and is awaited before parsing', async () => {
  let resolved = false;
  const res = {
    ok: true, status: 200, bodyUsed: false, headers: { get: () => null, has: () => false },
    text: () => new Promise((r) => setTimeout(() => { resolved = true; r(JSON.stringify({ variant: 'B' })); }, 5)),
  };
  const out = await load({ fetch: async () => res, kvs: kvsData({}) })(event({ cookies: { uid: UID } }));
  assert.ok(resolved);
  assert.equal(hv(out, 'x-ab-variant'), 'B');
  assert.equal(hv(out, 'x-ab-source'), 'origin');
});

test('warm visit, KVS hit: no fetch, only the uid read, x-ab-set-variant refreshes the ab cookie', async () => {
  const fetch = fetchAssigning('B');
  const kvs = kvsData({ [UID]: 'A' });
  const out = await load({ fetch, kvs })(event({ cookies: { uid: UID } }));
  assert.equal(fetch.calls.length, 0);
  assert.deepEqual(kvs.reads, [UID]);
  assert.equal(hv(out, 'x-ab-variant'), 'A');
  assert.equal(hv(out, 'x-ab-source'), 'kvs');
  assert.equal(hv(out, 'x-ab-kvs'), 'hit');
  assert.equal(hv(out, 'x-ab-uid-new'), undefined);
  assert.equal(hv(out, 'x-ab-set-uid'), undefined);
  assert.equal(hv(out, 'x-ab-set-variant'), 'A');
});

test('no KVS associated, first visit: uid still minted, kvs miss reported, the call still happens', async () => {
  const fetch = fetchAssigning('A');
  const out = await load({ fetch, kvs: noKvs })(event());
  assert.equal(fetch.calls.length, 1, 'a miss is a miss, whatever the reason');
  assert.match(hv(out, 'x-ab-kvs'), /^miss: KVS not associated/);
  assert.match(hv(out, 'x-ab-set-uid'), /^[a-f0-9]{16}$/);
  assert.equal(hv(out, 'x-ab-variant'), 'A');
  assert.equal(hv(out, 'x-ab-source'), 'origin');
});

test('viewer-supplied x-ab-set-* headers are stripped, never forwarded', async () => {
  const out = await load({ fetch: fetchAssigning('A'), kvs: kvsData({ [UID]: 'B' }) })(
    event({ cookies: { uid: UID }, headers: { 'x-ab-set-uid': 'ffffffffffffffff', 'x-ab-set-variant': 'Z' } }),
  );
  assert.equal(hv(out, 'x-ab-set-uid'), undefined);
  assert.equal(hv(out, 'x-ab-set-variant'), 'B');
});

test('cf.fetch undefined (TypeError) -> control fallback, error mentions fetch', async () => {
  const out = await load({ kvs: kvsData({}) })(event());
  assert.equal(hv(out, 'x-ab-variant'), 'control');
  assert.equal(hv(out, 'x-ab-source'), 'fallback');
  assert.match(hv(out, 'x-ab-error'), /fetch/);
  assert.match(hv(out, 'x-ab-set-uid'), /^[a-f0-9]{16}$/);
  assert.equal(hv(out, 'x-ab-set-variant'), undefined);
});

test('fetch failures and bad bodies fall back to control', async () => {
  const reset = async () => { throw new Error('connection reset'); };
  let out = await load({ fetch: reset, kvs: kvsData({}) })(event({ cookies: { uid: UID } }));
  assert.equal(hv(out, 'x-ab-variant'), 'control');
  assert.equal(hv(out, 'x-ab-error'), 'Error: connection reset', 'errors are reported by name');

  const bad = async () => response(200, { variant: 'Z' });
  out = await load({ fetch: bad, kvs: kvsData({}) })(event({ cookies: { uid: UID } }));
  assert.equal(hv(out, 'x-ab-variant'), 'control');
  assert.match(hv(out, 'x-ab-error'), /bad assign response, status 200/);
});

for (const name of ['TimeoutError', 'InternalError']) {
  test(`native ${name} -> control fallback, x-ab-error prefixed with the name`, async () => {
    const msg = name === 'TimeoutError' ? 'Request timed out' : 'Too many network calls';
    const out = await load({ fetch: async () => { throw named(name, msg); }, kvs: kvsData({}) })(event({ cookies: { uid: UID } }));
    assert.equal(hv(out, 'x-ab-variant'), 'control');
    assert.equal(hv(out, 'x-ab-source'), 'fallback');
    assert.equal(hv(out, 'x-ab-error'), `${name}: ${msg}`);
    assert.equal(hv(out, 'x-ab-set-variant'), undefined);
  });
}

test('a malformed uid cookie is replaced', async () => {
  const out = await load({ fetch: fetchAssigning('A'), kvs: kvsData({}) })(event({ cookies: { uid: 'not-hex' } }));
  const uid = hv(out, 'x-ab-uid');
  assert.match(uid, /^[a-f0-9]{16}$/);
  assert.equal(hv(out, 'x-ab-set-uid'), uid);
});

test('the function no longer reads statusCode or body()', () => {
  const code = src.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\.body\(\)/);
  assert.doesNotMatch(code, /statusCode/);
});
