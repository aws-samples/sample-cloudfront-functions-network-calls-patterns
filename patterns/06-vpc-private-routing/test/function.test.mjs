// Runs function.js under node with a fake `cloudfront` module so the routing
// logic can be checked without a distribution. The real runtime is CloudFront
// Functions runtime 2.0; this only proves the branches, not the platform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../function.js', import.meta.url), 'utf8')
  .replace("import cf from 'cloudfront';", 'const cf = new Proxy({}, { get: (_, k) => globalThis.__cf[k] });')
  .concat('\nexport { handler };');
const { handler } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const request = (uri, tenant) => ({
  request: { method: 'GET', uri, querystring: tenant ? { tenant: { value: tenant } } : {}, headers: {} },
});
// Fake cf. Every KVS read and every fetch / beacon call is recorded so the off
// paths can prove nothing went out.
const fake = ({ kv = {}, fetch } = {}) => {
  const data = { ...kv };
  const calls = { reads: [], fetch: [], beacon: [] };
  globalThis.__cf = {
    kvs: () => ({ get: (k) => (calls.reads.push(k), k in data && data[k] !== undefined ? Promise.resolve(data[k]) : Promise.reject(new Error('KeyNotFound'))) }),
    fetch: async (p, o) => { calls.fetch.push({ p, o }); if (!fetch) throw new Error('cf.fetch is not a function'); return fetch(p, o); },
    beacon: (p, o) => { calls.beacon.push({ p, o }); },
  };
  return calls;
};
// November runtime response: status / ok / headers (a Headers object) / text() returning a promise.
const reply = (status, text) => ({ ok: status >= 200 && status < 300, status, bodyUsed: false,
  headers: { get: () => null, has: () => false }, text: () => Promise.resolve(text) });
const routeResponse = (backend, status = 200) => async () => reply(status, JSON.stringify({ backend }));
const named = (name, message) => Object.assign(new Error(message), { name });

test('happy path: cf.fetch called with exact options, URI rewritten, x-backend set', async () => {
  const calls = fake({ fetch: routeResponse('green') });
  delete globalThis.__cf.beacon;
  const out = await handler(request('/patterns/vpc-private-routing/whoami', 'acme'));
  assert.equal(out.uri, '/patterns/vpc-private-routing/green/whoami');
  assert.equal(out.headers['x-backend'].value, 'green');
  assert.equal(out.headers['x-tenant'].value, 'acme');
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].p, '/route?tenant=acme');
  assert.deepEqual(calls.fetch[0].o, { originId: 'vpc-private-routing', includeBody: true });
  assert.deepEqual(calls.reads, ['routing-kill-switch']);
});

test('cf.fetch is the one used, never cf.beacon', async () => {
  const calls = fake({ fetch: routeResponse('blue') });
  const out = await handler(request('/patterns/vpc-private-routing/x', 'acme'));
  assert.equal(out.headers['x-backend'].value, 'blue');
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.beacon.length, 0);
});

test('text() is a promise and is awaited before parsing', async () => {
  let resolved = false;
  fake({ fetch: async () => ({ ok: true, status: 200, bodyUsed: false, headers: { get: () => null, has: () => false },
    text: () => new Promise((r) => setTimeout(() => { resolved = true; r(JSON.stringify({ backend: 'green' })); }, 5)) }) });
  const out = await handler(request('/patterns/vpc-private-routing/x', 'acme'));
  assert.equal(resolved, true);
  assert.equal(out.headers['x-backend'].value, 'green');
  assert.equal(out.headers['x-vpc-private-routing-error'], undefined);
});

test('kill switch off: no fetch, no beacon, URI unchanged', async () => {
  const calls = fake({ kv: { 'routing-kill-switch': 'off' }, fetch: routeResponse('green') });
  const out = await handler(request('/patterns/vpc-private-routing/whoami', 'acme'));
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.beacon.length, 0);
  assert.deepEqual(calls.reads, ['routing-kill-switch']);
  assert.equal(out.uri, '/patterns/vpc-private-routing/whoami');
  assert.equal(out.headers['x-backend'].value, 'off');
});

test('no KVS associated: kill switch reads as on (reason surfaced), the call still runs', async () => {
  const calls = fake({ fetch: routeResponse('blue') });
  globalThis.__cf.kvs = () => { throw new Error('KeyValueStore not associated'); };
  const out = await handler(request('/patterns/vpc-private-routing/x', 'acme'));
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.beacon.length, 0);
  assert.match(out.headers['x-vpc-private-routing-kvs-error'].value, /not associated/);
  assert.equal(out.headers['x-backend'].value, 'blue');
  assert.equal(out.uri, '/patterns/vpc-private-routing/blue/x');
});

test('cf.fetch throwing forwards unchanged with the error header', async () => {
  fake();
  const out = await handler(request('/patterns/vpc-private-routing/whoami', 'acme'));
  assert.equal(out.uri, '/patterns/vpc-private-routing/whoami');
  assert.equal(out.headers['x-backend'], undefined);
  assert.match(out.headers['x-vpc-private-routing-error'].value, /not a function/);
});

test('cf.fetch undefined (TypeError) still fails safe', async () => {
  fake(); delete globalThis.__cf.fetch;
  const out = await handler(request('/patterns/vpc-private-routing/whoami', 'acme'));
  assert.match(out.headers['x-vpc-private-routing-error'].value, /not a function/);
});

test('TimeoutError and InternalError are named in the error header, request unchanged', async () => {
  for (const name of ['TimeoutError', 'InternalError']) {
    fake({ fetch: async () => { throw named(name, 'boom'); } });
    const out = await handler(request('/patterns/vpc-private-routing/x', 'acme'));
    assert.equal(out.uri, '/patterns/vpc-private-routing/x');
    assert.equal(out.headers['x-backend'], undefined);
    assert.equal(out.headers['x-vpc-private-routing-error'].value, `${name}: boom`);
  }
});

test('non-200 from the route service and an unknown backend both fail safe', async () => {
  fake({ fetch: routeResponse('blue', 503) });
  assert.match((await handler(request('/patterns/vpc-private-routing/x', 'acme'))).headers['x-vpc-private-routing-error'].value, /503/);
  fake({ fetch: routeResponse('purple') });
  assert.match((await handler(request('/patterns/vpc-private-routing/x', 'acme'))).headers['x-vpc-private-routing-error'].value, /purple/);
});

test('tenant falls back to x-tenant header, then "guest"', async () => {
  fake({ fetch: routeResponse('blue') });
  const withHeader = request('/patterns/vpc-private-routing/', undefined);
  withHeader.request.headers['x-tenant'] = { value: 'from-header' };
  assert.equal((await handler(withHeader)).headers['x-tenant'].value, 'from-header');
  assert.equal((await handler(request('/patterns/vpc-private-routing/'))).headers['x-tenant'].value, 'guest');
});

test('missing kill-switch key is not an error', async () => {
  fake({ fetch: routeResponse('blue') });
  const out = await handler(request('/patterns/vpc-private-routing/x', 'acme'));
  assert.equal(out.headers['x-vpc-private-routing-kvs-error'], undefined);
  assert.equal(out.headers['x-backend'].value, 'blue');
});
