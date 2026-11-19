// Unit tests for function.js, run with: node --test patterns/01-cognito-auth/test/
// The CloudFront runtime module `cloudfront` is replaced by a stub on globalThis.
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
const tmp = join(mkdtempSync(join(tmpdir(), 'cognito-auth-')), 'function.mjs');
writeFileSync(tmp, source);
const { handler } = await import(pathToFileURL(tmp).href);

const request = (headers = {}) => ({ request: { method: 'GET', uri: '/patterns/cognito-auth/whoami', headers } });
const bearer = (extra = {}) => request({ authorization: { value: 'Bearer tok' }, ...extra });
// November runtime response: status / ok / headers (a Headers object), and text() returns a PROMISE.
// Non-async on purpose: the function only gets the body if it awaits the promise.
const cognito = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  bodyUsed: false,
  headers: { get: () => null, has: () => false },
  text: () => Promise.resolve(JSON.stringify(body)),
});
const named = (name, message) => Object.assign(new Error(message), { name });
let calls = [];
const stub = (impl) => {
  calls = [];
  globalThis.__cf = { fetch: async (path, opts) => { calls.push({ path, opts }); return impl(path, opts); } };
};

test('no Authorization header -> 401 missing_token, nothing fetched', async () => {
  stub(() => { throw new Error('must not be called'); });
  const res = await handler(request());
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).error, 'missing_token');
  assert.equal(res.headers['www-authenticate'].value, 'Bearer');
  assert.equal(calls.length, 0);
});

test('non-bearer Authorization -> 401 missing_token', async () => {
  stub(() => { throw new Error('must not be called'); });
  const res = await handler(request({ authorization: { value: 'Basic abc' } }));
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0);
});

test('valid token -> request forwarded with x-user-sub and x-user-name', async () => {
  stub(() => cognito(200, { Username: 'demo-user', UserAttributes: [{ Name: 'sub', Value: 'abc-123' }] }));
  const res = await handler(bearer());
  assert.equal(res.uri, '/patterns/cognito-auth/whoami');
  assert.equal(res.headers['x-user-sub'].value, 'abc-123');
  assert.equal(res.headers['x-user-name'].value, 'demo-user');
  assert.equal(calls.length, 1);
  const { path, opts } = calls[0];
  assert.equal(path, '/');
  assert.equal(opts.originId, 'cognito-auth');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers['x-amz-target'], 'AWSCognitoIdentityProviderService.GetUser');
  assert.equal(opts.headers['content-type'], 'application/x-amz-json-1.1');
  assert.deepEqual(JSON.parse(opts.body), { AccessToken: 'tok' });
  assert.deepEqual(Object.keys(opts).sort(), ['body', 'headers', 'includeBody', 'method', 'originId'], 'no timeout / cache options');
});

test('viewer-supplied x-user-* headers are stripped even on success', async () => {
  stub(() => cognito(200, { Username: 'demo-user', UserAttributes: [{ Name: 'sub', Value: 'real' }] }));
  const res = await handler(bearer({ 'x-user-sub': { value: 'forged' }, 'x-user-role': { value: 'admin' } }));
  assert.equal(res.headers['x-user-sub'].value, 'real');
  assert.equal(res.headers['x-user-role'], undefined);
});

test('Cognito rejects the token (400 NotAuthorizedException) -> 401 invalid_token', async () => {
  stub(() => cognito(400, { __type: 'NotAuthorizedException', message: 'Invalid Access Token' }));
  const res = await handler(bearer());
  assert.equal(res.statusCode, 401);
  assert.deepEqual(JSON.parse(res.body), { error: 'invalid_token' });
  assert.equal(res.headers['www-authenticate'].value, 'Bearer');
});

test('Cognito ok but no sub attribute -> 401 (fail closed)', async () => {
  stub(() => cognito(200, { Username: 'x', UserAttributes: [] }));
  const res = await handler(bearer());
  assert.equal(res.statusCode, 401);
});

test('cf.fetch throws TypeError -> 503 with x-cognito-auth-error, fail closed', async () => {
  stub(() => { throw new TypeError('(intermediate value)["fetch"] is not a function'); });
  const res = await handler(bearer());
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).error, 'auth_unavailable');
  assert.match(res.headers['x-cognito-auth-error'].value, /is not a function/);
});

test('cf.fetch undefined (module has no fetch) -> 503, fail closed', async () => {
  globalThis.__cf = {};
  const res = await handler(bearer());
  assert.equal(res.statusCode, 503);
  assert.ok(res.headers['x-cognito-auth-error']);
});

test('Cognito non-2xx -> 401 without reading the body', async () => {
  stub(() => ({ ok: false, status: 400, bodyUsed: false, headers: { get: () => null, has: () => false }, text: () => Promise.reject(new Error('must not be read')) }));
  const res = await handler(bearer());
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).error, 'invalid_token');
});

test('Cognito 200 with a body that is not JSON -> 503 SyntaxError, fail closed', async () => {
  stub(() => ({ ok: true, status: 200, bodyUsed: false, headers: { get: () => null, has: () => false }, text: () => Promise.resolve('<html>') }));
  const res = await handler(bearer());
  assert.equal(res.statusCode, 503);
  assert.match(res.headers['x-cognito-auth-error'].value, /^SyntaxError: /);
});

test('cf.fetch undefined -> 503 with the TypeError in x-cognito-auth-error, fail closed', async () => {
  stub(() => { throw new Error('must not be called'); });
  globalThis.__cf.fetch = undefined;
  const res = await handler(bearer());
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).error, 'auth_unavailable');
  assert.match(res.headers['x-cognito-auth-error'].value, /not a function/);
});

test('cf.fetch is the one called', async () => {
  stub(() => cognito(200, { Username: 'u', UserAttributes: [{ Name: 'sub', Value: 's1' }] }));
  const res = await handler(bearer());
  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0].opts.headers['x-amz-target'], 'string', 'plain string header map');
  assert.equal(res.headers['x-user-sub'].value, 's1');
});

test('text() promise is awaited: the sub, not "[object Promise]", reaches the header', async () => {
  stub(() => cognito(200, { Username: 'p', UserAttributes: [{ Name: 'sub', Value: 'from-promise' }] }));
  assert.equal((await handler(bearer())).headers['x-user-sub'].value, 'from-promise');
});

test('TimeoutError / InternalError -> 503 fail closed, error header prefixed with the name', async () => {
  for (const name of ['TimeoutError', 'InternalError']) {
    stub(() => { throw named(name, 'Request timed out'); });
    const res = await handler(bearer({ 'x-user-sub': { value: 'forged' } }));
    assert.equal(res.statusCode, 503, name);
    assert.equal(JSON.parse(res.body).error, 'auth_unavailable');
    assert.equal(res.headers['x-cognito-auth-error'].value, `${name}: Request timed out`);
    assert.equal(res.headers['x-user-sub'], undefined);
  }
});

test('a plain Error is reported by name too', async () => {
  stub(() => { throw new Error('boom'); });
  const res = await handler(bearer());
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['x-cognito-auth-error'].value, 'Error: boom');
});
