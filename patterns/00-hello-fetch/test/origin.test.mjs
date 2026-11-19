// node --test patterns/00-hello-fetch/test/origin.test.mjs
// The Fastify origin, exercised with app.inject (no network).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../lambda/app.mjs';

const app = buildApp({ secret: 's3cret' });
const ok = { 'x-origin-verify': 's3cret' };

test('GET /hello with the secret: the message the function copies', async () => {
  const res = await app.inject({ method: 'GET', url: '/hello', headers: ok });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().message, 'hello from the origin');
});

test('no secret or a wrong one: 403 on every route', async () => {
  for (const headers of [{}, { 'x-origin-verify': 'nope' }]) {
    assert.equal((await app.inject({ url: '/hello', headers })).statusCode, 403);
    assert.equal((await app.inject({ url: '/patterns/hello-fetch/', headers })).statusCode, 403);
  }
});

test('an app with no secret configured refuses everything', async () => {
  const open = buildApp({ secret: '' });
  assert.equal((await open.inject({ url: '/hello', headers: { 'x-origin-verify': '' } })).statusCode, 403);
});

test('the forwarded request: echoes only x-hello-* and hides the secret', async () => {
  const res = await app.inject({
    method: 'GET', url: '/patterns/hello-fetch/?a=1',
    headers: { ...ok, 'x-hello-message': 'hello from the origin', 'x-hello-status': '200', 'x-other': 'no' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    path: '/patterns/hello-fetch/',
    headersFromFunction: { 'x-hello-message': 'hello from the origin', 'x-hello-status': '200', 'x-origin-verify': '<present>' },
  });
});

test('a POST with a body reaches the echo too (no body hash needed behind a Web Function OAC)', async () => {
  const res = await app.inject({ method: 'POST', url: '/patterns/hello-fetch/', headers: { ...ok, 'content-type': 'application/json' }, payload: '{"a":1}' });
  assert.equal(res.statusCode, 200);
});
