// Runs both CloudFront Functions under node with a fake `cloudfront` module.
// node --test patterns/08-origin-health-fallback/function.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
async function load(file) {
  const src = readFileSync(join(here, file), 'utf8')
    .replace("import cf from 'cloudfront';", 'const cf = new Proxy({}, { get: (_, k) => globalThis.__cf[k] });') + '\nexport { handler };';
  return (await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))).handler;
}
const requestFn = await load('function.js');
const responseFn = await load('response-function.js');

const PREFIX = '/patterns/origin-health-fallback';
const h = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]));
const req = (uri, { query = {}, headers = {}, method = 'GET' } = {}) => ({
  request: { uri: PREFIX + uri, method, headers: h(headers), cookies: {}, querystring: h(query) },
});
// KVS answering the given keys; anything else rejects like a missing key.
const kvsWith = (data) => ({
  kvs: () => ({ get: async (k) => { if (!(k in data) || data[k] === undefined) throw new Error('KeyNotFound'); return data[k]; } }),
});
const noKeys = kvsWith({});
const noKvs = { kvs: () => { throw new Error('KVS not associated'); } };
// November runtime response: status, ok, headers (a Headers object), text() as a promise. No statusCode, no body().
const response = (status) => ({ ok: status >= 200 && status < 300, status, bodyUsed: false, headers: { get: () => null, has: () => false }, text: () => Promise.resolve('') });
const fetchReturning = (status) => {
  const calls = [];
  const fn = async (path, opts) => { calls.push({ path, opts }); return response(status); };
  fn.calls = calls;
  return fn;
};
const named = (name, message) => Object.assign(new Error(message), { name });
const helpers = () => {
  const h = { selected: [], groups: [] };
  h.selectRequestOriginById = (id) => h.selected.push(id);
  h.createRequestOriginGroup = (g) => h.groups.push(g);
  return h;
};
let H;
const run = (cf, ev) => { H = helpers(); globalThis.__cf = { ...H, ...cf }; return requestFn(ev); };
const GROUP = { originIds: [{ originId: 'origin-health-fallback' }, { originId: 'origin-health-fallback-static' }], failoverCriteria: { statusCodes: [500, 502, 503, 504] } };
// GET and includeBody: false are the defaults, so the probe passes only the origin.
const PROBE_OPTS = { originId: 'origin-health-fallback' };

// ---- request function: the gate ----

test('probe off by default (no health-probe key): no fetch, x-route primary, trailing slash -> index.html', async () => {
  const f = fetchReturning(200);
  const out = await run({ ...noKeys, fetch: f }, req('/'));
  assert.equal(f.calls.length, 0);
  assert.equal(out.uri, PREFIX + '/index.html');
  assert.equal(out.headers['x-route'].value, 'primary');
  assert.equal(out.headers['x-health-probe'].value, 'off');
  assert.deepEqual(H.groups, [GROUP], 'GET on the primary route builds the failover group per request');
  assert.deepEqual(H.selected, []);
});

test('KVS health-probe=off: no fetch even if the origin would fail', async () => {
  const f = fetchReturning(503);
  const out = await run({ ...kvsWith({ 'health-probe': 'off' }), fetch: f }, req('/index.html'));
  assert.equal(f.calls.length, 0);
  assert.equal(out.headers['x-route'].value, 'primary');
});

test('no KVS associated, ?probe=on: the probe still runs, POST fails over to the secondary', async () => {
  const f = fetchReturning(503);
  const out = await run({ ...noKvs, fetch: f }, req('/infer', { method: 'POST', query: { probe: 'on', simulate: 'down' } }));
  assert.equal(f.calls.length, 1);
  assert.equal(out.headers['x-route'].value, 'fallback');
  assert.equal(out.headers['x-health-probe'].value, 'unhealthy:503');
  assert.deepEqual(H.selected, ['origin-health-fallback-secondary']);
  assert.deepEqual(H.groups, [], 'POST never gets an origin group');
});

test('viewer cannot spoof x-route / x-health-probe*: stripped and rewritten', async () => {
  const out = await run({ ...noKeys, fetch: fetchReturning(200) }, req('/index.html', { headers: { 'x-route': 'fallback', 'x-health-probe-error': 'x', 'x-health-probe': 'on' } }));
  assert.equal(out.headers['x-route'].value, 'primary');
  assert.equal(out.headers['x-health-probe'].value, 'off');
  assert.equal(out.headers['x-health-probe-error'], undefined);
});

// ---- request function: the probe ----

test('probe: cf.fetch GET /health, no body, no timeout option', async () => {
  const f = fetchReturning(200);
  const out = await run({ ...kvsWith({ 'health-probe': 'on' }), fetch: f }, req('/index.html'));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, '/health');
  assert.deepEqual(f.calls[0].opts, PROBE_OPTS);
  assert.equal(out.headers['x-route'].value, 'primary');
  assert.equal(out.headers['x-health-probe'].value, 'ok');
});

test('?probe=on overrides KVS off (demo switch) and forwards ?simulate= to /health', async () => {
  const f = fetchReturning(200);
  const out = await run({ ...kvsWith({ 'health-probe': 'off' }), fetch: f }, req('/index.html', { query: { probe: 'on', simulate: 'slow' } }));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, '/health?simulate=slow');
  assert.equal(out.headers['x-route'].value, 'primary');
});

test('?probe=off overrides KVS on', async () => {
  const f = fetchReturning(200);
  await run({ ...kvsWith({ 'health-probe': 'on' }), fetch: f }, req('/index.html', { query: { probe: 'off' } }));
  assert.equal(f.calls.length, 0);
});

test('GET, probe sees 503: route to the S3 mirror, keep the uri (same paths)', async () => {
  const f = fetchReturning(503);
  const out = await run({ ...noKeys, fetch: f }, req('/about.html', { query: { probe: 'on', simulate: 'down' } }));
  assert.equal(out.uri, PREFIX + '/about.html');
  assert.equal(out.headers['x-route'].value, 'fallback');
  assert.equal(out.headers['x-health-probe'].value, 'unhealthy:503');
  assert.deepEqual(H.selected, ['origin-health-fallback-static'], 'mirror selected directly');
  assert.deepEqual(H.groups, []);
});

// ---- request function: POST, the point of the pattern ----

test('POST, probe healthy: primary, and NO origin group (groups do not fail over POST)', async () => {
  const f = fetchReturning(200);
  const out = await run({ ...noKeys, fetch: f }, req('/infer', { method: 'POST', query: { probe: 'on' } }));
  assert.deepEqual(f.calls[0].opts, PROBE_OPTS, 'the probe is a GET even when the viewer sent a POST');
  assert.equal(out.headers['x-route'].value, 'primary');
  assert.deepEqual(H.groups, []);
  assert.deepEqual(H.selected, []);
});

test('POST, probe sees 503: selectRequestOriginById(secondary Lambda), not the S3 mirror', async () => {
  const out = await run({ ...noKeys, fetch: fetchReturning(503) }, req('/infer', { method: 'POST', query: { probe: 'on', simulate: 'down' } }));
  assert.equal(out.headers['x-route'].value, 'fallback');
  assert.deepEqual(H.selected, ['origin-health-fallback-secondary']);
  assert.deepEqual(H.groups, []);
});

for (const method of ['PUT', 'PATCH', 'DELETE']) {
  test(`${method} fails over like POST: secondary, never a group`, async () => {
    await run({ ...noKeys, fetch: fetchReturning(500) }, req('/infer', { method, query: { probe: 'on' } }));
    assert.deepEqual(H.selected, ['origin-health-fallback-secondary']);
    assert.deepEqual(H.groups, []);
  });
}

test('HEAD is replayable: group on the primary route, mirror on fallback', async () => {
  await run({ ...noKeys, fetch: fetchReturning(200) }, req('/index.html', { method: 'HEAD', query: { probe: 'on' } }));
  assert.deepEqual(H.groups, [GROUP]);
  await run({ ...noKeys, fetch: fetchReturning(503) }, req('/index.html', { method: 'HEAD', query: { probe: 'on' } }));
  assert.deepEqual(H.selected, ['origin-health-fallback-static']);
});

// ---- request function: errors ----

test('TimeoutError: origin is slow or gone -> fallback, unhealthy:timeout, name in the error header', async () => {
  const f = async () => { throw named('TimeoutError', 'Request timed out'); };
  const out = await run({ ...noKeys, fetch: f }, req('/infer', { method: 'POST', query: { probe: 'on', simulate: 'slow' } }));
  assert.equal(out.headers['x-route'].value, 'fallback');
  assert.equal(out.headers['x-health-probe'].value, 'unhealthy:timeout');
  assert.equal(out.headers['x-health-probe-error'].value, 'TimeoutError: Request timed out');
  assert.deepEqual(H.selected, ['origin-health-fallback-secondary']);
});

test('any other error name (not TypeError) is a verdict: fallback, unhealthy:error', async () => {
  const f = async () => { throw named('LimitExceededError', 'too many in-flight network calls'); };
  const out = await run({ ...noKeys, fetch: f }, req('/infer', { method: 'POST', query: { probe: 'on' } }));
  assert.equal(out.headers['x-route'].value, 'fallback');
  assert.equal(out.headers['x-health-probe'].value, 'unhealthy:error');
  assert.match(out.headers['x-health-probe-error'].value, /^LimitExceededError: /);
  assert.deepEqual(H.selected, ['origin-health-fallback-secondary']);
});

test('TypeError (invalid call: bad argument, unknown origin id): FAIL OPEN to primary', async () => {
  const f = async () => { throw new TypeError('"cloudfront.fetch" unknown origin'); };
  const out = await run({ ...noKeys, fetch: f }, req('/infer', { method: 'POST', query: { probe: 'on' } }));
  assert.equal(out.headers['x-route'].value, 'primary');
  assert.equal(out.headers['x-health-probe'].value, 'unavailable');
  assert.equal(out.headers['x-health-probe-error'].value, 'TypeError: "cloudfront.fetch" unknown origin');
  assert.deepEqual(H.selected, []);
});

test('TypeError "... due to <result type>" (edge could not reach the primary): fallback, not fail open', async () => {
  for (const type of ['OriginDnsError', 'OriginConnectError', 'OriginCommError', 'AbortedOrigin']) {
    const message = '"cloudfront.fetch": The request could not be completed due to ' + type;
    const f = async () => { throw new TypeError(message); };
    const out = await run({ ...noKeys, fetch: f }, req('/infer', { method: 'POST', query: { probe: 'on' } }));
    assert.equal(out.headers['x-route'].value, 'fallback', type);
    assert.equal(out.headers['x-health-probe'].value, 'unhealthy:error', type);
    assert.equal(out.headers['x-health-probe-error'].value, 'TypeError: ' + message, type);
    assert.deepEqual(H.selected, ['origin-health-fallback-secondary'], type);
    H.selected.length = 0;
  }
});

test('TypeError for an unknown originId ("could not be completed, originId ..."): still FAIL OPEN', async () => {
  const f = async () => { throw new TypeError('"cloudfront.fetch": The request could not be completed, originId should match an origin on the distribution'); };
  const out = await run({ ...noKeys, fetch: f }, req('/infer', { method: 'POST', query: { probe: 'on' } }));
  assert.equal(out.headers['x-route'].value, 'primary');
  assert.equal(out.headers['x-health-probe'].value, 'unavailable');
});

test('InternalError (treat like a timeout): fallback, unhealthy:error', async () => {
  const f = async () => { throw named('InternalError', 'could not complete the call'); };
  const out = await run({ ...noKeys, fetch: f }, req('/index.html', { query: { probe: 'on' } }));
  assert.equal(out.headers['x-route'].value, 'fallback');
  assert.equal(out.headers['x-health-probe'].value, 'unhealthy:error');
  assert.equal(out.headers['x-health-probe-error'].value, 'InternalError: could not complete the call');
  assert.deepEqual(H.selected, ['origin-health-fallback-static']);
});

test('cf.fetch undefined (TypeError): FAIL OPEN -> primary, probe reported unavailable', async () => {
  const out = await run({ ...noKeys, fetch: undefined }, req('/index.html', { query: { probe: 'on' } }));
  assert.equal(out.headers['x-route'].value, 'primary');
  assert.equal(out.headers['x-health-probe'].value, 'unavailable');
  assert.match(out.headers['x-health-probe-error'].value, /not a function/);
  assert.deepEqual(H.groups, [GROUP]);
});

test('no self-timed budget: a late 2xx probe still routes to primary (only the runtime 1 s TimeoutError fails over)', async (t) => {
  // Date.now() does not advance across an awaited cf.fetch at the edge, so the function must not time the call.
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const f = async () => { now += 1500; return response(200); };
  const out = await run({ ...noKeys, fetch: f }, req('/infer', { method: 'POST', query: { probe: 'on', simulate: 'slow' } }));
  assert.equal(out.headers['x-route'].value, 'primary');
  assert.equal(out.headers['x-health-probe'].value, 'ok');
});

test('origin helpers missing: request still goes out, x-route-error records why', async () => {
  const out = await run({ ...noKeys, fetch: fetchReturning(503), selectRequestOriginById: undefined, createRequestOriginGroup: undefined }, req('/index.html', { query: { probe: 'on' } }));
  assert.equal(out.headers['x-route'].value, 'fallback');
  assert.match(out.headers['x-route-error'].value, /not a function/);
});

test('viewer x-route-error is stripped too', async () => {
  const out = await run({ ...noKeys }, req('/index.html', { headers: { 'x-route-error': 'spoof' } }));
  assert.equal(out.headers['x-route-error'], undefined);
});

// ---- response function: annotate only ----

const res = (reqHeaders, resHeaders) => ({
  request: { uri: PREFIX + '/index.html', method: 'GET', headers: h(reqHeaders), cookies: {}, querystring: {} },
  response: { statusCode: 200, statusDescription: 'OK', headers: h(resHeaders), cookies: {} },
});

test('response from the primary (x-origin: lambda): x-served-by primary, no x-fallback, no fetch', async () => {
  const f = fetchReturning(200);
  globalThis.__cf = { fetch: f };
  const out = await responseFn(res({ 'x-route': 'primary' }, { 'x-origin': 'lambda', 'content-type': 'text/html' }));
  assert.equal(f.calls.length, 0);
  assert.equal(out.headers['x-served-by'].value, 'primary');
  assert.equal(out.headers['x-fallback'], undefined);
  assert.equal(out.headers['x-route'].value, 'primary');
  assert.equal(out.headers['x-origin'], undefined);
});

test('response from the secondary (x-origin: lambda-secondary): x-served-by secondary, x-fallback true', async () => {
  globalThis.__cf = {};
  const out = await responseFn(res({ 'x-route': 'fallback', 'x-health-probe': 'unhealthy:503' }, { 'x-origin': 'lambda-secondary' }));
  assert.equal(out.headers['x-served-by'].value, 'secondary');
  assert.equal(out.headers['x-fallback'].value, 'true');
  assert.equal(out.headers['x-health-probe'].value, 'unhealthy:503');
});

test('fail-open evidence is copied from the request onto the response', async () => {
  globalThis.__cf = {};
  const out = await responseFn(res({ 'x-route': 'primary', 'x-health-probe': 'unavailable', 'x-health-probe-error': 'TypeError: cf.fetch is not a function' }, { 'x-origin': 'lambda' }));
  assert.equal(out.headers['x-health-probe'].value, 'unavailable');
  assert.match(out.headers['x-health-probe-error'].value, /not a function/);
  assert.equal(out.headers['x-route-error'], undefined, 'absent request headers are not invented');
});

test('response without a Lambda marker (S3): x-served-by fallback, x-fallback true', async () => {
  globalThis.__cf = {};
  const out = await responseFn(res({ 'x-route': 'fallback' }, { etag: '"abc"', 'content-type': 'text/html' }));
  assert.equal(out.headers['x-served-by'].value, 'fallback');
  assert.equal(out.headers['x-fallback'].value, 'true');
  assert.equal(out.headers['x-route'].value, 'fallback');
});

test('an unknown marker value is not trusted as a role', async () => {
  globalThis.__cf = {};
  const out = await responseFn(res({}, { 'x-origin': 'constructor' }));
  assert.equal(out.headers['x-served-by'].value, 'fallback');
});

test('origin-group failover shows as x-route primary but x-served-by fallback', async () => {
  globalThis.__cf = {};
  const out = await responseFn(res({ 'x-route': 'primary' }, { etag: '"abc"' }));
  assert.equal(out.headers['x-route'].value, 'primary');
  assert.equal(out.headers['x-served-by'].value, 'fallback');
});
