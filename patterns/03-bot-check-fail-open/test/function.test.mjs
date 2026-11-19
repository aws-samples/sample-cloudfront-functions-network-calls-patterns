// node --test patterns/03-bot-check-fail-open/test
// Loads function.js with a fake `cloudfront` module and drives every branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'function.js'), 'utf8')
  .replace(/^import cf from 'cloudfront';\s*/m, '');

/** Build a handler bound to a fake `cf` object. */
function load(cf) {
  return new Function('cf', `${src}\nreturn handler;`)(cf);
}

// November runtime response shape: status / ok / headers (a Headers object) / promise text().
// text() is a plain function returning a promise, so a missing await would hand JSON.parse a Promise.
const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  bodyUsed: false,
  headers: { get: () => null, has: () => false },
  text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
});
const okFetch = (verdict, score = 0) => async () => response(200, { verdict, score });
/** Spy fetch: records every call, answers with `res`. */
const spyFetch = (res = response(200, { verdict: 'human', score: 0 })) => {
  const calls = [];
  const fn = async (path, opts) => { calls.push({ path, opts }); return res; };
  fn.calls = calls;
  return fn;
};
const named = (name, message) => Object.assign(new Error(message), { name });

// Fake KVS: answers 'bot-policy'; a missing key rejects.
const kvsData = (data) => () => ({ get: async (k) => { if (!(k in data)) throw new Error('KeyNotFound'); return data[k]; } });
/** An optional bot-policy value. */
const kvsWith = (policy) => kvsData(policy === undefined ? {} : { 'bot-policy': policy });
/** No bot-policy key: the policy falls back to the default. */
const kvsNoPolicy = kvsWith();
const kvsMissing = () => { throw new Error('no KVS associated'); };

const event = (headers = {}) => ({
  viewer: { ip: '203.0.113.9' },
  request: {
    method: 'GET',
    uri: '/patterns/bot-check-fail-open/echo',
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, { value: v }])),
  },
});
const hv = (out, name) => out.headers[name] && out.headers[name].value;

// --- KVS ---

test('no KVS associated: the call still happens, policy falls back to tag with the reason', async () => {
  const fetch = spyFetch(response(200, { verdict: 'human', score: 0 }));
  const out = await load({ fetch, kvs: kvsMissing })(event());
  assert.equal(fetch.calls.length, 1, 'the call does not depend on KVS');
  assert.equal(hv(out, 'x-bot-check'), 'ok');
  assert.equal(hv(out, 'x-bot-policy'), 'tag');
  assert.match(hv(out, 'x-bot-policy-source'), /^default: Error: no KVS associated/);
});

test('bot-policy read from KVS', async () => {
  const out = await load({ fetch: okFetch('human'), kvs: kvsWith('block') })(event());
  assert.equal(hv(out, 'x-bot-policy'), 'block');
  assert.equal(hv(out, 'x-bot-policy-source'), 'kvs');
});

// --- vendor failures: fail open ---

test('fail open: cf.fetch undefined (TypeError) forwards with unavailable + error header', async () => {
  const handler = load({ kvs: kvsNoPolicy });
  const out = await handler(event({ 'user-agent': 'Googlebot' }));
  assert.equal(out.uri, '/patterns/bot-check-fail-open/echo', 'request forwarded');
  assert.equal(hv(out, 'x-bot-check'), 'unavailable');
  assert.match(hv(out, 'x-bot-check-fail-open-error'), /fetch/);
  assert.equal(hv(out, 'x-bot-policy'), 'tag');
  assert.match(hv(out, 'x-bot-policy-source'), /^default/);
  assert.equal(hv(out, 'x-bot-verdict'), undefined);
});

test('fail open: plain fetch rejection forwards with unavailable, error by name', async () => {
  const handler = load({ fetch: async () => { throw new Error('connection reset'); }, kvs: kvsWith('block') });
  const out = await handler(event({ 'user-agent': 'Googlebot' }));
  assert.equal(hv(out, 'x-bot-check'), 'unavailable');
  assert.equal(hv(out, 'x-bot-check-fail-open-error'), 'Error: connection reset');
  assert.equal(hv(out, 'x-bot-policy'), 'block', 'policy still read even though vendor failed');
  assert.equal(out.statusCode, undefined, 'not blocked');
});

for (const name of ['TimeoutError', 'InternalError']) {
  test(`fail open: native ${name} -> unavailable, error header prefixed with the name`, async () => {
    const msg = name === 'TimeoutError' ? 'Request timed out' : 'Too many network calls';
    const handler = load({ fetch: async () => { throw named(name, msg); }, kvs: kvsWith('block') });
    const out = await handler(event());
    assert.equal(out.statusCode, undefined, 'not blocked');
    assert.equal(hv(out, 'x-bot-check'), 'unavailable');
    assert.equal(hv(out, 'x-bot-check-fail-open-error'), `${name}: ${msg}`);
  });
}

test('fail open: vendor non-200 is treated as unavailable', async () => {
  const handler = load({ fetch: async () => response(502, '{}'), kvs: kvsNoPolicy });
  const out = await handler(event());
  assert.equal(hv(out, 'x-bot-check'), 'unavailable');
  assert.equal(hv(out, 'x-bot-check-fail-open-error'), 'Error: vendor returned 502');
});

test('fail open: unreadable verdict is treated as unavailable', async () => {
  const handler = load({ fetch: async () => response(200, { verdict: 'maybe' }), kvs: kvsWith('block') });
  const out = await handler(event());
  assert.equal(hv(out, 'x-bot-check'), 'unavailable');
  assert.equal(hv(out, 'x-bot-check-fail-open-error'), 'Error: vendor verdict unreadable');
});

test('no self-timed budget: a late 200 verdict is still used (only the runtime 1 s TimeoutError fails open)', async (t) => {
  // Date.now() does not advance across an awaited cf.fetch at the edge, so the function must not time the call.
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const handler = load({ fetch: async () => { now += 2000; return response(200, { verdict: 'bot', score: 100 }); }, kvs: kvsWith('block') });
  const out = await handler(event());
  assert.equal(out.statusCode, 403, 'verdict used, blocked');
});

// --- policy branches ---

test('tag (default policy): bot verdict is forwarded with headers, not blocked', async () => {
  const handler = load({ fetch: okFetch('bot', 60), kvs: kvsNoPolicy });
  const out = await handler(event());
  assert.equal(out.statusCode, undefined);
  assert.equal(hv(out, 'x-bot-verdict'), 'bot');
  assert.equal(hv(out, 'x-bot-score'), '60');
  assert.equal(hv(out, 'x-bot-policy'), 'tag');
});

test('block: bot verdict returns 403 page', async () => {
  const handler = load({ fetch: okFetch('bot', 100), kvs: kvsWith('block') });
  const out = await handler(event());
  assert.equal(out.statusCode, 403);
  assert.match(out.body, /Blocked/);
  assert.equal(hv(out, 'x-bot-verdict'), 'bot');
});

test('block: human verdict passes through', async () => {
  const handler = load({ fetch: okFetch('human', 0), kvs: kvsWith('block') });
  const out = await handler(event());
  assert.equal(out.statusCode, undefined);
  assert.equal(hv(out, 'x-bot-verdict'), 'human');
});

test('off: verdict ignored, nothing blocked, no verdict header', async () => {
  const handler = load({ fetch: okFetch('bot', 100), kvs: kvsWith('off') });
  const out = await handler(event());
  assert.equal(out.statusCode, undefined);
  assert.equal(hv(out, 'x-bot-check'), 'ok');
  assert.equal(hv(out, 'x-bot-verdict'), undefined);
});

test('unknown KVS value falls back to tag', async () => {
  const handler = load({ fetch: okFetch('bot', 100), kvs: kvsWith('nuke') });
  const out = await handler(event());
  assert.equal(hv(out, 'x-bot-policy'), 'tag');
  assert.match(hv(out, 'x-bot-policy-source'), /not block\|tag\|off/);
});

test('viewer-supplied x-bot-* headers are stripped', async () => {
  const handler = load({ fetch: okFetch('human', 0), kvs: kvsNoPolicy });
  const out = await handler(event({ 'x-bot-verdict': 'human', 'x-bot-check': 'ok', 'x-bot-spoof': '1' }));
  assert.equal(hv(out, 'x-bot-spoof'), undefined);
  assert.equal(hv(out, 'x-bot-verdict'), 'human', 'set by the function, not the viewer');
});

// --- the call itself ---

test('cf.fetch: POST /check on own origin, exact options, no timeout', async () => {
  const fetch = spyFetch();
  await load({ fetch, kvs: kvsNoPolicy })(event({ 'user-agent': 'curl/8', 'accept-language': 'en', 'x-force-verdict': 'bot', 'x-mock-delay-ms': '2000' }));
  assert.equal(fetch.calls.length, 1);
  const { path, opts } = fetch.calls[0];
  assert.equal(path, '/check');
  assert.deepEqual(Object.keys(opts).sort(), ['body', 'headers', 'includeBody', 'method', 'originId'], 'no timeout');
  assert.equal(opts.originId, 'bot-check-fail-open');
  assert.equal(opts.method, 'POST');
  assert.deepEqual(Object.keys(opts.headers), ['content-type'], 'plain string map, not { value }; no body hash');
  assert.equal(opts.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(opts.body), {
    path: '/patterns/bot-check-fail-open/echo',
    ip: '203.0.113.9',
    userAgent: 'curl/8',
    acceptLanguage: 'en',
    forceVerdict: 'bot',
    delayMs: '2000',
  });
});

test('cf.fetch undefined: fails open, TypeError in x-bot-check-fail-open-error', async () => {
  const out = await load({ kvs: kvsNoPolicy })(event());
  assert.equal(out.headers['x-bot-check'].value, 'unavailable');
  assert.match(out.headers['x-bot-check-fail-open-error'].value, /not a function/);
});

test('text() returns a promise and is awaited before parsing', async () => {
  let resolved = false;
  const res = {
    ok: true, status: 200, bodyUsed: false, headers: { get: () => null, has: () => false },
    text: () => new Promise((r) => setTimeout(() => { resolved = true; r(JSON.stringify({ verdict: 'bot', score: 77 })); }, 5)),
  };
  const out = await load({ fetch: async () => res, kvs: kvsWith('tag') })(event());
  assert.ok(resolved);
  assert.equal(hv(out, 'x-bot-check'), 'ok');
  assert.equal(hv(out, 'x-bot-verdict'), 'bot');
  assert.equal(hv(out, 'x-bot-score'), '77');
});

test('the function no longer reads statusCode or body()', () => {
  const code = src.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\.body\(\)/);
  assert.doesNotMatch(code, /res\.statusCode/);
});
