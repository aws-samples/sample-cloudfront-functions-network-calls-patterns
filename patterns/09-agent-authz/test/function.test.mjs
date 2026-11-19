// Unit tests for function.js, run with: node --test 'patterns/09-agent-authz/test/*.test.mjs'
// The CloudFront runtime module `cloudfront` is replaced by a stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'function.js'), 'utf8')
  .replace("import cf from 'cloudfront';", 'const cf = { get fetch() { return globalThis.__cf.fetch; } };')
  .concat('\nexport { handler };\n');
const tmp = join(mkdtempSync(join(tmpdir(), 'agent-authz-')), 'function.mjs');
writeFileSync(tmp, source);
const { handler } = await import(pathToFileURL(tmp).href);

const ALLOWED = '/patterns/agent-authz/orders/48291';
const OTHER = '/patterns/agent-authz/orders/70113';
const request = (uri, { method = 'GET', headers = {} } = {}) => ({
  viewer: { ip: '203.0.113.9' },
  request: { method, uri, headers: { 'user-agent': { value: 'agent/1' }, ...headers } },
});
const agent = (uri, opts = {}) => request(uri, { ...opts, headers: { authorization: { value: 'Bearer demo-agent-token' } } });
// Runtime response: status / ok / headers (a Headers object), and text() returns a PROMISE.
// Non-async on purpose: the function only gets the body if it awaits the promise.
const raw = (status, text) => ({ ok: status >= 200 && status < 300, status, bodyUsed: false, headers: { get: () => null, has: () => false }, text: () => Promise.resolve(text) });
const reply = (status, body) => raw(status, JSON.stringify(body));
const named = (name, message) => Object.assign(new Error(message), { name });
let calls = [];
const stub = (impl) => {
  calls = [];
  globalThis.__cf = { fetch: async (path, opts) => { calls.push({ path, opts }); return impl(path, opts); } };
};

test('no Authorization header -> 401 at the edge, no call made', async () => {
  stub(() => { throw new Error('must not be called'); });
  const res = await handler(request(ALLOWED));
  assert.equal(res.statusCode, 401);
  assert.equal(res.statusDescription, 'Unauthorized');
  assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized' });
  assert.equal(res.headers['www-authenticate'].value, 'Bearer');
  assert.equal(res.headers['cache-control'].value, 'no-store');
  assert.equal(calls.length, 0);
});

test('allowed -> the request is forwarded unchanged', async () => {
  stub(() => reply(200, { allowed: true }));
  const event = agent(ALLOWED);
  const res = await handler(event);
  assert.equal(res, event.request);
  assert.equal(res.uri, ALLOWED);
});

test('not allowed on this resource -> 403 JSON from the function', async () => {
  stub(() => reply(200, { allowed: false }));
  const res = await handler(agent(OTHER));
  assert.equal(res.statusCode, 403);
  assert.equal(res.statusDescription, 'Forbidden');
  assert.deepEqual(JSON.parse(res.body), { error: 'forbidden' });
  assert.equal(res.headers['cache-control'].value, 'no-store');
  assert.equal(res.headers['x-agent-authz-error'], undefined);
});

test('the fetch is one POST /v1/check on origin agent-authz with { action, resource, token }', async () => {
  stub(() => reply(200, { allowed: true }));
  await handler(agent(ALLOWED));
  assert.equal(calls.length, 1);
  const { path, opts } = calls[0];
  assert.equal(path, '/v1/check');
  assert.equal(opts.originId, 'agent-authz');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.includeBody, true);
  assert.deepEqual(Object.keys(opts).sort(), ['body', 'headers', 'includeBody', 'method', 'originId'], 'no timeout / cache options');
  assert.equal(opts.headers['content-type'], 'application/json');
  assert.equal(opts.headers.authorization, undefined, 'OAC owns the authorization header of the call');
  assert.deepEqual(JSON.parse(opts.body), { action: 'read', resource: ALLOWED, token: 'Bearer demo-agent-token' });
});

test('no body hash header: the Web Function OAC signs the POST with an unsigned payload', async () => {
  stub(() => reply(200, { allowed: true }));
  await handler(agent(ALLOWED));
  assert.deepEqual(Object.keys(calls[0].opts.headers), ['content-type']);
});

test('action comes from the method: GET/HEAD read, everything else write', async () => {
  const cases = { GET: 'read', HEAD: 'read', POST: 'write', PUT: 'write', PATCH: 'write', DELETE: 'write' };
  for (const [method, action] of Object.entries(cases)) {
    stub(() => reply(200, { allowed: false }));
    await handler(agent(ALLOWED, { method }));
    assert.equal(JSON.parse(calls[0].opts.body).action, action, method);
  }
});

test('allowed must be exactly true: "true", 1, missing, null all deny', async () => {
  for (const allowed of ['true', 1, undefined, null]) {
    stub(() => reply(200, { allowed }));
    const res = await handler(agent(ALLOWED));
    assert.equal(res.statusCode, 403, `allowed=${String(allowed)}`);
  }
  stub(() => reply(200, null));
  assert.equal((await handler(agent(ALLOWED))).statusCode, 403, 'body null');
});

test('authz answers non-2xx -> 503 naming the status, fail closed', async () => {
  for (const status of [403, 500, 502]) {
    stub(() => reply(status, { allowed: true }));
    const res = await handler(agent(ALLOWED));
    assert.equal(res.statusCode, 503, String(status));
    assert.equal(res.statusDescription, 'Service Unavailable');
    assert.deepEqual(JSON.parse(res.body), { error: 'authz_unavailable' });
    assert.equal(res.headers['x-agent-authz-error'].value, `authz returned ${status}`);
  }
});

test('TimeoutError / InternalError / TypeError -> 503 fail closed, error header prefixed with the name', async () => {
  for (const name of ['TimeoutError', 'InternalError', 'TypeError']) {
    stub(() => { throw named(name, 'Request timed out'); });
    const res = await handler(agent(ALLOWED));
    assert.equal(res.statusCode, 503, name);
    assert.deepEqual(JSON.parse(res.body), { error: 'authz_unavailable' });
    assert.equal(res.headers['x-agent-authz-error'].value, `${name}: Request timed out`);
  }
});

test('cf.fetch undefined -> 503 with the TypeError, fail closed', async () => {
  globalThis.__cf = {};
  const res = await handler(agent(ALLOWED));
  assert.equal(res.statusCode, 503);
  assert.match(res.headers['x-agent-authz-error'].value, /^TypeError: .*not a function/);
});

test('authz body is not JSON -> 503, fail closed', async () => {
  stub(() => raw(200, 'not json'));
  const res = await handler(agent(ALLOWED));
  assert.equal(res.statusCode, 503);
  assert.match(res.headers['x-agent-authz-error'].value, /^SyntaxError: /);
});

test('text() promise is awaited: the decision comes from the resolved body', async () => {
  stub(() => reply(200, { allowed: true }));
  assert.equal((await handler(agent(ALLOWED))).uri, ALLOWED);
  stub(() => reply(200, { allowed: false }));
  assert.equal((await handler(agent(ALLOWED))).statusCode, 403);
});

test('an empty Authorization header is a 401 with no call, like a missing one', async () => {
  for (const value of ['', '   ']) {
    stub(() => { throw new Error('must not be called'); });
    const res = await handler(request(ALLOWED, { headers: { authorization: { value } } }));
    assert.equal(res.statusCode, 401, JSON.stringify(value));
    assert.equal(calls.length, 0);
  }
});
