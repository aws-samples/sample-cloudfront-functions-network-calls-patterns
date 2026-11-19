// Unit tests for function.js, run with: node --test 'patterns/02-authorizer-headers/test/*.test.mjs'
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
const tmp = join(mkdtempSync(join(tmpdir(), 'authorizer-headers-')), 'function.mjs');
writeFileSync(tmp, source);
const { handler } = await import(pathToFileURL(tmp).href);

const request = (headers = {}) => ({
  viewer: { ip: '203.0.113.9' },
  request: { method: 'GET', uri: '/patterns/authorizer-headers/echo', headers: { 'user-agent': { value: 'curl/8' }, ...headers } },
});
const bearer = (token, extra = {}) => request({ authorization: { value: 'Bearer ' + token }, ...extra });
// November runtime response: status / ok / headers (a Headers object), and text() returns a PROMISE.
// Non-async on purpose: the function only gets the body if it awaits the promise.
const raw = (status, text) => ({ ok: status >= 200 && status < 300, status, bodyUsed: false, headers: { get: () => null, has: () => false }, text: () => Promise.resolve(text) });
const reply = (status, body) => raw(status, JSON.stringify(body));
const named = (name, message) => Object.assign(new Error(message), { name });
let calls = [];
const stub = (impl) => {
  calls = [];
  globalThis.__cf = { fetch: async (path, opts) => { calls.push({ path, opts }); return impl(path, opts); } };
};

test('allow -> request forwarded with x-tenant and x-role from the authorizer', async () => {
  stub(() => reply(200, { allow: true, headers: { 'x-tenant': 'acme', 'x-role': 'admin' } }));
  const res = await handler(bearer('demo-admin'));
  assert.equal(res.uri, '/patterns/authorizer-headers/echo');
  assert.equal(res.headers['x-tenant'].value, 'acme');
  assert.equal(res.headers['x-role'].value, 'admin');
  assert.equal(res.headers.authorization.value, 'Bearer demo-admin', 'authorization is forwarded untouched');
});

test('the fetch is one POST /authorize on origin authorizer-headers with the viewer context', async () => {
  stub(() => reply(200, { allow: true, headers: {} }));
  await handler(bearer('demo-admin'));
  assert.equal(calls.length, 1);
  const { path, opts } = calls[0];
  assert.equal(path, '/authorize');
  assert.equal(opts.originId, 'authorizer-headers');
  assert.equal(opts.method, 'POST');
  assert.deepEqual(Object.keys(opts).sort(), ['body', 'headers', 'includeBody', 'method', 'originId'], 'no timeout / cache options');
  assert.equal(opts.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(opts.body), {
    ip: '203.0.113.9',
    uri: '/patterns/authorizer-headers/echo',
    method: 'GET',
    headers: { authorization: 'Bearer demo-admin', 'user-agent': 'curl/8' },
  });
  assert.ok(opts.body.length < 64 * 1024);
});

test('no x-amz-content-sha256: the OAC signs the POST with an unsigned payload', async () => {
  stub(() => reply(200, { allow: true, headers: {} }));
  await handler(bearer('demo-admin'));
  assert.deepEqual(Object.keys(calls[0].opts.headers), ['content-type']);
});

test('missing authorization -> still asks the authorizer, with an empty string', async () => {
  stub(() => reply(200, { allow: false, headers: {} }));
  const res = await handler(request());
  assert.equal(JSON.parse(calls[0].opts.body).headers.authorization, '');
  assert.equal(res.statusCode, 403);
});

test('deny -> 403 JSON from the function, origin never reached', async () => {
  stub(() => reply(200, { allow: false, headers: {} }));
  const res = await handler(bearer('nope'));
  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body), { error: 'forbidden' });
  assert.equal(res.headers['cache-control'].value, 'no-store');
  assert.equal(res.headers['x-authorizer-headers-error'], undefined);
});

test('viewer-supplied x-tenant / x-role are stripped, even on allow', async () => {
  stub(() => reply(200, { allow: true, headers: { 'x-tenant': 'acme', 'x-role': 'admin' } }));
  const res = await handler(bearer('demo-admin', { 'x-tenant': { value: 'forged' }, 'x-role': { value: 'root' } }));
  assert.equal(res.headers['x-tenant'].value, 'acme');
  assert.equal(res.headers['x-role'].value, 'admin');
});

test('viewer-supplied x-role is stripped when the authorizer grants only x-tenant', async () => {
  stub(() => reply(200, { allow: true, headers: { 'x-tenant': 'acme' } }));
  const res = await handler(bearer('demo-admin', { 'x-role': { value: 'root' } }));
  assert.equal(res.headers['x-tenant'].value, 'acme');
  assert.equal(res.headers['x-role'], undefined);
});

test('authorizer header names are lowercased; unknown headers are ignored', async () => {
  stub(() => reply(200, { allow: true, headers: { 'X-Tenant': 'acme', 'X-Role': 'admin', 'x-evil': 'yes', host: 'x' } }));
  const res = await handler(bearer('demo-admin'));
  assert.equal(res.headers['x-tenant'].value, 'acme');
  assert.equal(res.headers['x-role'].value, 'admin');
  assert.equal(res.headers['x-evil'], undefined);
  assert.equal(res.headers.host, undefined);
});

test('allow must be exactly true: "true", 1, missing all deny', async () => {
  for (const allow of ['true', 1, undefined, null]) {
    stub(() => reply(200, { allow, headers: { 'x-role': 'admin' } }));
    const res = await handler(bearer('demo-admin'));
    assert.equal(res.statusCode, 403, `allow=${String(allow)}`);
  }
});

test('cf.fetch throws TypeError -> 503 with x-authorizer-headers-error, fail closed', async () => {
  stub(() => { throw new TypeError('(intermediate value)["fetch"] is not a function'); });
  const res = await handler(bearer('demo-admin'));
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), { error: 'authorizer_unavailable' });
  assert.match(res.headers['x-authorizer-headers-error'].value, /is not a function/);
});

test('cf.fetch undefined (module has no fetch) -> 503, fail closed', async () => {
  globalThis.__cf = {};
  const res = await handler(bearer('demo-admin'));
  assert.equal(res.statusCode, 503);
  assert.ok(res.headers['x-authorizer-headers-error']);
});

test('authorizer answers non-2xx (e.g. 403 from the origin lock) -> 503 naming the status', async () => {
  stub(() => reply(403, { error: 'missing or wrong x-origin-verify header' }));
  const res = await handler(bearer('demo-admin'));
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['x-authorizer-headers-error'].value, 'authorizer returned 403');
});

test('authorizer answers 502 -> 503 naming the status', async () => {
  stub(() => reply(502, {}));
  const res = await handler(bearer('demo-admin'));
  assert.equal(res.headers['x-authorizer-headers-error'].value, 'authorizer returned 502');
});

test('authorizer body is not JSON -> 503, fail closed', async () => {
  stub(() => raw(200, 'not json'));
  const res = await handler(bearer('demo-admin'));
  assert.equal(res.statusCode, 503);
  assert.match(res.headers['x-authorizer-headers-error'].value, /^SyntaxError: /);
});

test('cf.fetch undefined -> 503 with the TypeError in x-authorizer-headers-error, fail closed', async () => {
  stub(() => { throw new Error('must not be called'); });
  globalThis.__cf.fetch = undefined;
  const res = await handler(bearer('demo-admin'));
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), { error: 'authorizer_unavailable' });
  assert.match(res.headers['x-authorizer-headers-error'].value, /not a function/);
});

test('cf.fetch is the one called with a plain string header map', async () => {
  stub(() => reply(200, { allow: true, headers: { 'x-tenant': 'acme' } }));
  const res = await handler(bearer('demo-admin'));
  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0].opts.headers['content-type'], 'string');
  assert.equal(res.headers['x-tenant'].value, 'acme');
});

test('text() promise is awaited: the decision and its headers come from the resolved body', async () => {
  stub(() => reply(200, { allow: true, headers: { 'x-role': 'from-promise' } }));
  const res = await handler(bearer('demo-admin'));
  assert.equal(res.headers['x-role'].value, 'from-promise');
  stub(() => reply(200, { allow: false }));
  assert.equal((await handler(bearer('x'))).statusCode, 403);
});

test('TimeoutError / InternalError -> 503 fail closed, error header prefixed with the name', async () => {
  for (const name of ['TimeoutError', 'InternalError']) {
    stub(() => { throw named(name, 'Request timed out'); });
    const res = await handler(bearer('demo-admin'));
    assert.equal(res.statusCode, 503, name);
    assert.deepEqual(JSON.parse(res.body), { error: 'authorizer_unavailable' });
    assert.equal(res.headers['x-authorizer-headers-error'].value, `${name}: Request timed out`);
  }
});

test('a plain Error is reported by name too', async () => {
  stub(() => { throw new Error('boom'); });
  const res = await handler(bearer('demo-admin'));
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['x-authorizer-headers-error'].value, 'Error: boom');
});
