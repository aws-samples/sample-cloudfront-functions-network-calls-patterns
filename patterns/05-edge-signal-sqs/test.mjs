// Unit tests for function.js (viewer-request) and response-function.js (viewer-response).
// Run with: node patterns/05-edge-signal-sqs/test.mjs
// Loads each function source with the `cloudfront` module replaced by a stub.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sources = {
  request: readFileSync(join(here, 'function.js'), 'utf8'),
  response: readFileSync(join(here, 'response-function.js'), 'utf8'),
};

function load(which, cfStub) {
  const body = sources[which].replace(/^import .*$/gm, '') + '\nreturn handler;';
  return new Function('cf', 'crypto', body)(cfStub, crypto);
}

const URI = '/patterns/edge-signal-sqs/hello';
const BEACON_KEYS = ['body', 'headers', 'logDeliveryErrors', 'method', 'originId'];

const event = () => ({
  viewer: { ip: '203.0.113.7' },
  request: { uri: URI, method: 'GET', headers: { 'user-agent': { value: 'curl/8' } } },
});

// Viewer-response event: the request as CloudFront saw it (after the request function)
// plus the response about to go to the viewer.
const responseEvent = (statusCode, requestHeaders = {}) => ({
  viewer: { ip: '203.0.113.7' },
  request: { uri: URI, method: 'GET', headers: { 'x-signal-id': { value: URI }, ...requestHeaders } },
  response: { statusCode, headers: { 'content-type': { value: 'application/json' } } },
});

// cf stub with spies on beacon and fetch. beacon: null leaves it out (a host without
// network calls). fetch is a spy only: this pattern must never call it.
function stub({ beacon = () => undefined } = {}) {
  const calls = { fetch: [], beacon: [] };
  const cf = { fetch: async (path, opts) => { calls.fetch.push({ path, opts }); throw new Error('cf.fetch must not be called'); } };
  if (beacon) cf.beacon = (path, opts) => { calls.beacon.push({ path, opts }); return beacon(path, opts); };
  return { cf, calls };
}

// ---------------------------------------------------------------- viewer-request

// 1. One beacon to the pattern's own origin: plain string headers, logDeliveryErrors, no
//    includeBody (it throws on a beacon), no timeout. Returns undefined, nothing awaited.
{
  const { cf, calls } = stub();
  const out = await load('request', cf)(event());
  assert.equal(out.headers['x-signal'].value, 'beacon');
  assert.equal(out.headers['x-signal-error'], undefined);
  assert.equal(calls.beacon.length, 1);
  assert.equal(calls.fetch.length, 0);
  const { path, opts } = calls.beacon[0];
  assert.equal(path, '/patterns/signal');
  assert.deepEqual(Object.keys(opts).sort(), BEACON_KEYS);
  assert.equal(opts.originId, 'edge-signal-sqs');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.logDeliveryErrors, true);
  assert.deepEqual(opts.headers, { 'content-type': 'application/json' });
  const signal = JSON.parse(opts.body);
  assert.equal(signal.kind, 'requested');
  assert.equal(signal.uri, URI);
  assert.equal(signal.ua, 'curl/8');
  assert.equal(signal.ip.length, 16);
  assert.notEqual(signal.ip, '203.0.113.7');
  assert.ok(Number.isInteger(signal.ts));
  assert.equal(out.uri, URI);
}

// 2. cf.beacon throwing (a bad option, a second call in one invocation): failed, name-prefixed,
//    request forwarded. A plain Error is reported by name too.
{
  const err = new TypeError('"cloudfront.beacon" only one network call per invocation');
  const { cf, calls } = stub({ beacon: () => { throw err; } });
  const out = await load('request', cf)(event());
  assert.equal(out.headers['x-signal'].value, 'failed');
  assert.equal(out.headers['x-signal-error'].value, 'TypeError: "cloudfront.beacon" only one network call per invocation');
  assert.equal(calls.fetch.length, 0);
  assert.equal(out.uri, URI);
  const plain = await load('request', stub({ beacon: () => { throw new Error('boom'); } }).cf)(event());
  assert.equal(plain.headers['x-signal-error'].value, 'Error: boom');
}

// 3. cf.beacon undefined (TypeError): fails safe, request forwarded.
{
  const out = await load('request', stub({ beacon: null }).cf)(event());
  assert.equal(out.headers['x-signal'].value, 'failed');
  assert.match(out.headers['x-signal-error'].value, /not a function/);
  assert.equal(out.uri, URI);
}

// 4. Dedup id fits the SQS 128-char cap even for long URIs; no user-agent is fine.
{
  const { cf, calls } = stub();
  const e = event();
  e.request.uri = '/patterns/edge-signal-sqs/' + 'x'.repeat(500);
  delete e.request.headers['user-agent'];
  await load('request', cf)(e);
  const signal = JSON.parse(calls.beacon[0].opts.body);
  assert.equal(signal.uri.length, 128);
  assert.equal(signal.ua, '');
}

// 5. The request carries the dedup id forward as x-signal-id so the response side can correlate.
//    It is set even when the call failed: correlation must not depend on the queue call.
{
  const out = await load('request', stub({ beacon: null }).cf)(event());
  assert.equal(out.headers['x-signal-id'].value, URI);
  const e = event();
  e.request.uri = '/patterns/edge-signal-sqs/' + 'x'.repeat(500);
  const long = await load('request', stub({ beacon: null }).cf)(e);
  assert.equal(long.headers['x-signal-id'].value.length, 128);
}

// ---------------------------------------------------------------- viewer-response

// 6. The common case: a 200 with no sample switch. No call, response untouched except the marker.
{
  const { cf, calls } = stub();
  const out = await load('response', cf)(responseEvent(200));
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.beacon.length, 0);
  assert.equal(out.headers['x-signal-served'].value, 'skipped');
  assert.equal(out.statusCode, 200);
  assert.equal(out.headers['content-type'].value, 'application/json');
}

// 7. Skipped never touches cf at all: any property read on it throws.
{
  const cf = new Proxy({}, { get: (_, k) => { throw new Error('cf.' + String(k) + ' touched'); } });
  const out = await load('response', cf)(responseEvent(200));
  assert.equal(out.headers['x-signal-served'].value, 'skipped');
  assert.equal(out.headers['x-signal-served-error'], undefined);
}

// 8. 5xx: one beacon with the served event, distinct dedup id, correlated by signalId.
{
  const { cf, calls } = stub();
  const out = await load('response', cf)(responseEvent(503));
  assert.equal(out.headers['x-signal-served'].value, 'beacon');
  assert.equal(out.statusCode, 503);
  assert.equal(calls.beacon.length, 1);
  assert.equal(calls.fetch.length, 0);
  const { path, opts } = calls.beacon[0];
  assert.equal(path, '/patterns/signal');
  assert.deepEqual(Object.keys(opts).sort(), BEACON_KEYS);
  assert.equal(opts.originId, 'edge-signal-sqs');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.logDeliveryErrors, true);
  assert.deepEqual(opts.headers, { 'content-type': 'application/json' });
  const served = JSON.parse(opts.body);
  assert.equal(served.kind, 'served');
  assert.equal(served.uri, URI);
  assert.equal(served.status, 503);
  assert.equal(served.signalId, URI);
  assert.equal(served.dedupId, `served:${URI}:503`);
  assert.ok(Number.isInteger(served.ts));
}

// 9. cf.beacon throwing on the way out, or missing: failed, response still goes out.
{
  const err = new TypeError('"cloudfront.beacon" only one network call per invocation');
  const thrown = await load('response', stub({ beacon: () => { throw err; } }).cf)(responseEvent(500));
  assert.equal(thrown.headers['x-signal-served'].value, 'failed');
  assert.equal(thrown.headers['x-signal-served-error'].value, 'TypeError: "cloudfront.beacon" only one network call per invocation');
  assert.equal(thrown.statusCode, 500);
  const missing = await load('response', stub({ beacon: null }).cf)(responseEvent(500));
  assert.equal(missing.headers['x-signal-served'].value, 'failed');
  assert.match(missing.headers['x-signal-served-error'].value, /not a function/);
}

// 10. Demo switch: x-signal-sample: 1 on the request fires the served event even for a 200.
{
  const { cf, calls } = stub();
  const out = await load('response', cf)(responseEvent(200, { 'x-signal-sample': { value: '1' } }));
  assert.equal(out.headers['x-signal-served'].value, 'beacon');
  assert.equal(calls.beacon.length, 1);
  assert.equal(JSON.parse(calls.beacon[0].opts.body).status, 200);
}

// 11. Any other value of x-signal-sample is not the switch.
{
  const { cf, calls } = stub();
  const out = await load('response', cf)(responseEvent(200, { 'x-signal-sample': { value: 'yes' } }));
  assert.equal(out.headers['x-signal-served'].value, 'skipped');
  assert.equal(calls.beacon.length, 0);
}

// 12. No x-signal-id on the request (unknown whether request-function headers reach the
//     response event): fall back to the URI, capped like the request side.
{
  const { cf, calls } = stub();
  const e = responseEvent(502);
  delete e.request.headers['x-signal-id'];
  e.request.uri = '/patterns/edge-signal-sqs/' + 'x'.repeat(500);
  await load('response', cf)(e);
  const served = JSON.parse(calls.beacon[0].opts.body);
  assert.equal(served.signalId.length, 128);
  assert.ok(served.dedupId.length <= 128);
}

console.log('ok: 12 cases passed');
