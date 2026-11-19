// node --test patterns/01-cognito-auth/test/origin.test.mjs
// The echo origin's Fastify app, exercised with app.inject (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../lambda/app.mjs';

const app = buildApp({ secret: 's3cret' });

test('wrong or missing x-origin-verify -> 403', async () => {
  for (const headers of [{ 'x-user-sub': 'abc' }, { 'x-origin-verify': 'nope', 'x-user-sub': 'abc' }]) {
    const res = await app.inject({ url: '/whoami', headers });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { error: 'missing or wrong x-origin-verify header' });
  }
});

test('an app with no secret configured refuses everything', async () => {
  const open = buildApp({ secret: '' });
  assert.equal((await open.inject({ url: '/whoami', headers: { 'x-origin-verify': '' } })).statusCode, 403);
});

test('echoes only x-user-* headers', async () => {
  const res = await app.inject({
    url: '/patterns/cognito-auth/whoami?x=1',
    headers: { 'x-origin-verify': 's3cret', 'x-user-sub': 'abc', 'x-user-name': 'demo-user', authorization: 'Bearer tok' },
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^application\/json/);
  const body = res.json();
  assert.deepEqual(body.identity, { 'x-user-sub': 'abc', 'x-user-name': 'demo-user' });
  assert.equal(body.path, '/patterns/cognito-auth/whoami');
});

test('a POST with any body reaches the echo (no body hash needed behind a Web Function OAC)', async () => {
  const res = await app.inject({
    method: 'POST', url: '/patterns/cognito-auth/whoami',
    headers: { 'x-origin-verify': 's3cret', 'content-type': 'application/json' }, payload: 'not json',
  });
  assert.equal(res.statusCode, 200);
});
