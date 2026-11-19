import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handler, backendFor, backendFromPath } from '../lambda/index.mjs';

const albEvent = (path, query = {}, headers = {}) => ({ path, queryStringParameters: query, headers, httpMethod: 'GET' });

test('backendFor is stable and uses both colours', () => {
  assert.equal(backendFor('acme'), backendFor('acme'));
  assert.deepEqual(new Set(['a', 'b', 'acme', 'globex'].map(backendFor)), new Set(['blue', 'green']));
});

test('GET /route returns the backend for a tenant', async () => {
  const res = await handler(albEvent('/route', { tenant: 'acme' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { tenant: 'acme', backend: backendFor('acme') });
});

test('GET /route without a tenant is a 400', async () => {
  const res = await handler(albEvent('/route'));
  assert.equal(res.statusCode, 400);
});

test('blue and green paths echo their backend and the function headers', async () => {
  assert.equal(backendFromPath('/patterns/vpc-private-routing/blue/whoami'), 'blue');
  assert.equal(backendFromPath('/patterns/vpc-private-routing/green'), 'green');
  assert.equal(backendFromPath('/patterns/vpc-private-routing/whoami'), 'none');
  const res = await handler(albEvent('/patterns/vpc-private-routing/green/whoami', {}, { 'x-backend': 'green', 'x-tenant': 'acme', host: 'ignored' }));
  const body = JSON.parse(res.body);
  assert.equal(body.backend, 'green');
  assert.deepEqual(body.headersFromFunction, { 'x-backend': 'green', 'x-tenant': 'acme' });
});

test('every response has the shape an ALB Lambda target accepts', async () => {
  const events = [albEvent('/route', { tenant: 'acme' }), albEvent('/route'), albEvent('/patterns/vpc-private-routing/blue/x')];
  for (const ev of events) {
    const res = await handler(ev);
    assert.equal(typeof res.statusCode, 'number');
    assert.equal(res.isBase64Encoded, false);
    assert.equal(typeof res.body, 'string');
    for (const v of Object.values(res.headers)) assert.equal(typeof v, 'string');
    // ALB rejects a statusDescription that is not "<code> <reason>", e.g. a bare "200".
    if (res.statusDescription !== undefined) assert.match(res.statusDescription, /^\d{3} [A-Za-z]/);
  }
});
