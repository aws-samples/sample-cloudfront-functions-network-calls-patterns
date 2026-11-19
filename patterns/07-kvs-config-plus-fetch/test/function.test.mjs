// node --test patterns/07-kvs-config-plus-fetch/test
// Runs the viewer-request function under node with a fake `cloudfront` module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'function.js'), 'utf8')
  .replace(/^import cf from 'cloudfront';\s*/m, '');
const load = (cf) => new Function('cf', `${src}\nreturn handler;`)(cf);

const NOW = Math.floor(Date.now() / 1000);
// Fake KVS: key -> value (objects, as format json returns them). A missing key rejects. Records reads.
const kvsData = (data) => {
  const reads = [];
  const fn = () => ({ get: async (k, opts) => { reads.push([k, opts]); if (!(k in data)) throw new Error('KeyNotFound'); return data[k]; } });
  fn.reads = reads;
  return fn;
};
const noKvs = () => { throw new Error('KVS not associated'); };
// November runtime response shape: status / ok / headers (a Headers object) / promise text().
const response = (status, body) => ({
  ok: status >= 200 && status < 300, status, bodyUsed: false, headers: { get: () => null, has: () => false },
  text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
});
const fetchReturning = (status, body) => {
  const calls = [];
  const fn = async (path, opts) => { calls.push({ path, opts }); return response(status, body); };
  fn.calls = calls;
  return fn;
};
const fetchThrowing = (err) => {
  const calls = [];
  const fn = async (path, opts) => { calls.push({ path, opts }); throw err; };
  fn.calls = calls;
  return fn;
};
const named = (name, message) => Object.assign(new Error(message), { name });
const ev = (uri, headers = {}) => ({ request: { method: 'GET', uri: '/patterns/kvs-config-plus-fetch' + uri, headers, querystring: {}, cookies: {} } });
const hdr = (out, k) => out.headers[k] && out.headers[k].value;
const ORIGIN_CONFIG = { plan: 'pro', model: 'medium', rateLimit: 100 };

test('fresh KVS entry: used as is, no network call', async () => {
  const kvs = kvsData({ 'cfg-globex': { exp: NOW + 300, config: ORIGIN_CONFIG } });
  const fetch = fetchReturning(200, {});
  const out = await load({ kvs, fetch })(ev('/globex'));
  assert.equal(fetch.calls.length, 0);
  assert.deepEqual(kvs.reads, [['cfg-globex', { format: 'json' }]]);
  assert.equal(hdr(out, 'x-config-source'), 'kvs');
  assert.equal(hdr(out, 'x-config-key'), 'globex');
  assert.deepEqual(JSON.parse(hdr(out, 'x-config')), ORIGIN_CONFIG);
  assert.equal(out.uri, '/patterns/kvs-config-plus-fetch/globex', 'forwarded unchanged');
});

test('KVS miss: exactly one call with the exact options, config and hits from the body', async () => {
  const fetch = fetchReturning(200, { config: ORIGIN_CONFIG, hits: 3, threshold: 5 });
  const out = await load({ kvs: kvsData({}), fetch })(ev('/globex'));
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].path, '/config/globex');
  assert.deepEqual(fetch.calls[0].opts, { originId: 'kvs-config-plus-fetch', includeBody: true });
  assert.equal(hdr(out, 'x-config-source'), 'origin');
  assert.equal(hdr(out, 'x-config-hits'), '3/5');
  assert.deepEqual(JSON.parse(hdr(out, 'x-config')), ORIGIN_CONFIG);
  assert.equal(out.headers['x-config-error'], undefined);
});

test('no KVS associated: a miss, the call is still made', async () => {
  const fetch = fetchReturning(200, { config: ORIGIN_CONFIG, hits: 1, threshold: 5 });
  const out = await load({ kvs: noKvs, fetch })(ev('/globex'));
  assert.equal(fetch.calls.length, 1);
  assert.equal(hdr(out, 'x-config-source'), 'origin');
});

test('expired KVS entry: treated as a miss and refreshed from the origin', async () => {
  const kvs = kvsData({ 'cfg-globex': { exp: NOW - 1, config: { plan: 'old' } } });
  const fetch = fetchReturning(200, { config: ORIGIN_CONFIG, hits: 1, threshold: 5 });
  const out = await load({ kvs, fetch })(ev('/globex'));
  assert.equal(fetch.calls.length, 1);
  assert.equal(hdr(out, 'x-config-source'), 'origin');
  assert.deepEqual(JSON.parse(hdr(out, 'x-config')), ORIGIN_CONFIG);
});

test('call fails with an expired entry: the stale entry is served, error named', async () => {
  const kvs = kvsData({ 'cfg-globex': { exp: NOW - 1, config: { plan: 'old' } } });
  const out = await load({ kvs, fetch: fetchThrowing(named('TimeoutError', 'timed out')) })(ev('/globex'));
  assert.equal(hdr(out, 'x-config-source'), 'kvs-stale');
  assert.deepEqual(JSON.parse(hdr(out, 'x-config')), { plan: 'old' });
  assert.equal(hdr(out, 'x-config-error'), 'TimeoutError: timed out');
});

for (const [label, fetch, error] of [
  ['TypeError', fetchThrowing(named('TypeError', 'bad origin')), 'TypeError: bad origin'],
  ['InternalError', fetchThrowing(named('InternalError', 'boom')), 'InternalError: boom'],
  ['a 403', fetchReturning(403, { message: 'Forbidden' }), 'Error: origin returned 403'],
  ['a body without config', fetchReturning(200, { hits: 1 }), 'Error: no config in the origin response'],
]) {
  test(`call fails with ${label} and nothing in KVS: DEFAULT, request still forwarded`, async () => {
    const out = await load({ kvs: kvsData({}), fetch })(ev('/globex'));
    assert.equal(out.uri, '/patterns/kvs-config-plus-fetch/globex');
    assert.equal(hdr(out, 'x-config-source'), 'default');
    assert.deepEqual(JSON.parse(hdr(out, 'x-config')), { plan: 'free', model: 'small', rateLimit: 10 });
    assert.equal(hdr(out, 'x-config-error'), error);
  });
}

test('bad JSON body: SyntaxError, DEFAULT', async () => {
  const out = await load({ kvs: kvsData({}), fetch: fetchReturning(200, '<html>') })(ev('/globex'));
  assert.equal(hdr(out, 'x-config-source'), 'default');
  assert.match(hdr(out, 'x-config-error'), /^SyntaxError/);
});

test('awaits the text() promise before parsing', async () => {
  let resolved = false;
  const fetch = async () => ({ ok: true, status: 200, bodyUsed: false, headers: { get: () => null, has: () => false },
    text: () => new Promise((r) => setTimeout(() => { resolved = true; r(JSON.stringify({ config: ORIGIN_CONFIG, hits: 1, threshold: 5 })); }, 5)) });
  const out = await load({ kvs: kvsData({}), fetch })(ev('/globex'));
  assert.equal(resolved, true);
  assert.equal(hdr(out, 'x-config-source'), 'origin');
});

test('viewer-supplied x-config-* headers are dropped', async () => {
  const forged = Object.fromEntries(['x-config', 'x-config-key', 'x-config-source', 'x-config-hits', 'x-config-error']
    .map((h) => [h, { value: 'forged' }]));
  const out = await load({ kvs: kvsData({}), fetch: fetchReturning(200, { config: ORIGIN_CONFIG, hits: null, threshold: 5 }) })(ev('/globex', forged));
  assert.equal(hdr(out, 'x-config-source'), 'origin');
  assert.equal(out.headers['x-config-hits'], undefined, 'not counted, so no hits header');
  assert.equal(out.headers['x-config-error'], undefined);
  assert.equal(hdr(out, 'x-config-key'), 'globex');
});

test('no key in the path reads the key default', async () => {
  const fetch = fetchReturning(200, { config: ORIGIN_CONFIG, hits: 1, threshold: 5 });
  const out = await load({ kvs: kvsData({}), fetch })(ev('/'));
  assert.equal(fetch.calls[0].path, '/config/default');
  assert.equal(hdr(out, 'x-config-key'), 'default');
});

test('invalid key: 400 from the edge, no KVS read, no call', async () => {
  const kvs = kvsData({});
  const fetch = fetchReturning(200, {});
  const out = await load({ kvs, fetch })(ev('/Bad_Key'));
  assert.equal(out.statusCode, 400);
  assert.equal(kvs.reads.length, 0);
  assert.equal(fetch.calls.length, 0);
});

test('never calls cf.beacon', async () => {
  const beacon = () => assert.fail('beacon called');
  await load({ kvs: kvsData({}), fetch: fetchReturning(200, { config: ORIGIN_CONFIG, hits: 1, threshold: 5 }), beacon })(ev('/globex'));
});
