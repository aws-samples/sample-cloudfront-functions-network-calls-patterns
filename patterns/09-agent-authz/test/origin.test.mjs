// node --test patterns/09-agent-authz/test/origin.test.mjs
// The Fastify origin, exercised with app.inject (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../lambda/app.mjs';

const app = buildApp({ secret: 'shh' });
const ok = { 'x-origin-verify': 'shh' };

const ALLOWED = '/patterns/agent-authz/orders/48291';
const OTHER = '/patterns/agent-authz/orders/70113';
const check = (body, headers = { 'content-type': 'application/json' }) =>
  app.inject({ method: 'POST', url: '/v1/check', headers: { ...ok, ...headers }, payload: JSON.stringify(body) });

test('no secret or a wrong one -> 403, on every path', async () => {
  for (const headers of [{}, { 'x-origin-verify': 'nope' }]) {
    for (const url of ['/v1/check', ALLOWED]) {
      const res = await app.inject({ method: url === '/v1/check' ? 'POST' : 'GET', url, headers });
      assert.equal(res.statusCode, 403, url);
      assert.deepEqual(res.json(), { error: 'missing or wrong x-origin-verify header' });
    }
  }
});

test('an app with no secret configured refuses everything', async () => {
  const open = buildApp({ secret: '' });
  assert.equal((await open.inject({ url: ALLOWED, headers: { 'x-origin-verify': '' } })).statusCode, 403);
});

test('demo token may read order 48291', async () => {
  const res = await check({ action: 'read', resource: ALLOWED, token: 'Bearer demo-agent-token' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { allowed: true });
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('demo token may not read order 70113, nor write order 48291', async () => {
  for (const [action, resource] of [['read', OTHER], ['write', ALLOWED]]) {
    const res = await check({ action, resource, token: 'Bearer demo-agent-token' });
    assert.deepEqual(res.json(), { allowed: false }, `${action} ${resource}`);
  }
});

test('other tokens, a missing token or no Bearer prefix -> allowed false', async () => {
  for (const token of ['Bearer nope', 'demo-agent-token', '', undefined, 42]) {
    const res = await check({ action: 'read', resource: ALLOWED, token });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { allowed: false }, String(token));
  }
});

test('POST /v1/check parses the body whatever its content type (no body hash needed behind a Web Function OAC)', async () => {
  for (const headers of [{ 'content-type': 'text/plain' }, { 'content-type': 'application/octet-stream' }, {}]) {
    const res = await check({ action: 'read', resource: ALLOWED, token: 'Bearer demo-agent-token' }, headers);
    assert.equal(res.json().allowed, true, JSON.stringify(headers));
  }
});

test('POST /v1/check with a non-JSON body -> 400; GET -> 405', async () => {
  const bad = await app.inject({ method: 'POST', url: '/v1/check', headers: { ...ok, 'content-type': 'application/json' }, payload: 'not json' });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(bad.json(), { error: 'body is not JSON' });
  const empty = await app.inject({ method: 'POST', url: '/v1/check', headers: ok });
  assert.equal(empty.statusCode, 400);
  const get = await app.inject({ method: 'GET', url: '/v1/check', headers: ok });
  assert.equal(get.statusCode, 405);
  assert.deepEqual(get.json(), { error: 'POST only' });
});

test('any other path is the orders backend: a cacheable order', async () => {
  const res = await app.inject({ method: 'GET', url: `${ALLOWED}?x=1`, headers: ok });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(res.headers['cache-control'], 'public, max-age=60');
  assert.equal(res.json().order, '48291');
  assert.equal(res.json().status, 'shipped');
});
