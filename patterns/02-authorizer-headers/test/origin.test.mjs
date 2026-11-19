// node --test 'patterns/02-authorizer-headers/test/*.test.mjs'
// The Fastify origin, exercised with app.inject (no network).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../lambda/app.mjs';

const app = buildApp({ secret: 'shh' });
const ok = { 'x-origin-verify': 'shh' };
const authorize = (authorization) => app.inject({
  method: 'POST', url: '/authorize',
  headers: { ...ok, 'content-type': 'application/json' },
  payload: JSON.stringify({ ip: '1.2.3.4', uri: '/x', method: 'GET', headers: { authorization, 'user-agent': 'curl' } }),
});

test('no secret or a wrong one -> 403, on every path', async () => {
  for (const headers of [{}, { 'x-origin-verify': 'nope' }]) {
    for (const url of ['/authorize', '/patterns/authorizer-headers/echo']) {
      const res = await app.inject({ method: url === '/authorize' ? 'POST' : 'GET', url, headers });
      assert.equal(res.statusCode, 403, url);
      assert.deepEqual(res.json(), { error: 'missing or wrong x-origin-verify header' });
    }
  }
});

test('an app with no secret configured refuses everything', async () => {
  const open = buildApp({ secret: '' });
  assert.equal((await open.inject({ url: '/patterns/authorizer-headers/echo', headers: { 'x-origin-verify': '' } })).statusCode, 403);
});

test('POST /authorize with Bearer demo-admin -> allow, tenant acme, role admin', async () => {
  const res = await authorize('Bearer demo-admin');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.deepEqual(res.json(), { allow: true, headers: { 'x-tenant': 'acme', 'x-role': 'admin' } });
});

test('POST /authorize with demo-viewer and demo-globex -> their own identities', async () => {
  assert.deepEqual((await authorize('Bearer demo-viewer')).json().headers, { 'x-tenant': 'acme', 'x-role': 'viewer' });
  assert.deepEqual((await authorize('Bearer demo-globex')).json().headers, { 'x-tenant': 'globex', 'x-role': 'admin' });
});

test('POST /authorize with any other token, or none -> allow false', async () => {
  for (const auth of ['Bearer nope', 'Bearer DEMO-ADMIN', 'Basic abc', '', undefined]) {
    const res = await authorize(auth);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { allow: false, headers: {} }, String(auth));
  }
});

test('POST /authorize with no x-amz-content-sha256 and any content type is accepted', async () => {
  const res = await app.inject({
    method: 'POST', url: '/authorize', headers: { ...ok, 'content-type': 'text/plain' },
    payload: JSON.stringify({ headers: { authorization: 'Bearer demo-admin' } }),
  });
  assert.equal(res.json().allow, true);
});

test('POST /authorize with a non-JSON or empty body -> 400', async () => {
  for (const payload of ['not json', '']) {
    const res = await app.inject({ method: 'POST', url: '/authorize', headers: { ...ok, 'content-type': 'application/json' }, payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.deepEqual(res.json(), { error: 'body is not JSON' });
  }
});

test('GET /authorize -> 405', async () => {
  const res = await app.inject({ method: 'GET', url: '/authorize', headers: ok });
  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.json(), { error: 'POST only' });
});

test('echo shows only x-tenant and x-role from the incoming headers', async () => {
  const res = await app.inject({
    url: '/patterns/authorizer-headers/echo?a=1',
    headers: { ...ok, 'x-tenant': 'acme', 'x-role': 'admin', authorization: 'Bearer demo-admin' },
  });
  const body = res.json();
  assert.equal(res.statusCode, 200);
  assert.equal(body.path, '/patterns/authorizer-headers/echo');
  assert.deepEqual(body.identity, { 'x-tenant': 'acme', 'x-role': 'admin' });
  assert.match(body.note, /Viewer-supplied values are stripped/);
});
