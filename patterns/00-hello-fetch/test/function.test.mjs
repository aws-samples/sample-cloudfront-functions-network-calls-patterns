// node --test patterns/00-hello-fetch/test
// Runs function.js under node with a fake `cloudfront` module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'function.js'), 'utf8')
  .replace(/^import cf from 'cloudfront';\s*/m, '');
const load = (cf) => new Function('cf', `${src}\nreturn handler;`)(cf);

const event = () => ({ request: { method: 'GET', uri: '/patterns/hello-fetch/', headers: {} } });
const hv = (out, name) => out.headers[name] && out.headers[name].value;
// November runtime response: status / ok / headers (a Headers object), and text() returns a PROMISE.
// Non-async on purpose: the function only gets the string if it awaits the promise.
const reply = (status, text) => ({ ok: status >= 200 && status < 300, status, bodyUsed: false, headers: { get: () => null, has: () => false }, text: () => Promise.resolve(text) });
const named = (name, message) => Object.assign(new Error(message), { name });

test('cf.fetch -> x-hello-message and x-hello-status, called with exactly originId + includeBody (GET is the default)', async () => {
  const calls = [];
  const fetch = async (path, opts) => { calls.push({ path, opts }); return reply(200, '{"message":"hi"}'); };
  const out = await load({ fetch })(event());
  assert.deepEqual(calls, [{ path: '/hello', opts: { originId: 'hello-fetch', includeBody: true } }], 'no method, no timeout key');
  assert.equal(hv(out, 'x-hello-message'), 'hi');
  assert.equal(hv(out, 'x-hello-status'), '200');
});

test('cf.fetch is the one called', async () => {
  let n = 0;
  const cf = { fetch: async () => { n++; return reply(201, '{"message":"b"}'); } };
  const out = await load(cf)(event());
  assert.equal(n, 1);
  assert.equal(hv(out, 'x-hello-message'), 'b');
  assert.equal(hv(out, 'x-hello-status'), '201');
});

test('text() promise is awaited: the JSON field, not "[object Promise]", reaches the header', async () => {
  const out = await load({ fetch: async () => reply(200, '{"message":"from-promise"}') })(event());
  assert.equal(hv(out, 'x-hello-message'), 'from-promise');
  assert.equal(hv(out, 'x-hello-error'), undefined);
});

test('no fetch at all -> x-hello-error is a TypeError, request forwarded', async () => {
  const out = await load({})(event());
  assert.match(hv(out, 'x-hello-error'), /^TypeError: .*not a function/);
  assert.equal(out.uri, '/patterns/hello-fetch/');
});

test('TimeoutError / InternalError -> request forwarded, x-hello-error prefixed with the name', async () => {
  for (const name of ['TimeoutError', 'InternalError']) {
    const out = await load({ fetch: async () => { throw named(name, 'Request timed out'); } })(event());
    assert.equal(out.uri, '/patterns/hello-fetch/');
    assert.equal(hv(out, 'x-hello-error'), `${name}: Request timed out`);
    assert.equal(hv(out, 'x-hello-message'), undefined);
  }
});

test('a body that is not JSON -> SyntaxError in x-hello-error, request forwarded', async () => {
  const out = await load({ fetch: async () => reply(200, 'not json') })(event());
  assert.match(hv(out, 'x-hello-error'), /^SyntaxError: /);
  assert.equal(hv(out, 'x-hello-message'), undefined);
});

test('viewer-supplied x-hello-* headers are dropped: a forged error never reaches the origin', async () => {
  const forged = event();
  forged.request.headers = { 'x-hello-error': { value: 'forged' }, 'x-hello-message': { value: 'forged' }, 'x-hello-status': { value: '999' } };
  const out = await load({ fetch: async () => reply(200, '{"message":"hello from the origin"}') })(forged);
  assert.equal(out.headers['x-hello-error'], undefined);
  assert.equal(hv(out, 'x-hello-message'), 'hello from the origin');
  assert.equal(hv(out, 'x-hello-status'), '200');
});
