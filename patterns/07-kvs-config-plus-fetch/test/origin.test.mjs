// node --test patterns/07-kvs-config-plus-fetch/test
// The Fastify origin, exercised with app.inject (no network): DynamoDB is a stub client.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../lambda/app.mjs';
import { THRESHOLD, counterItem } from '../lambda/hot.mjs';
import { lookup } from '../lambda/source.mjs';

function stubDdb(hits = 3) {
  const calls = [];
  return { calls, send: async (command) => { calls.push(command.input); return { Attributes: { hits: { N: String(hits) } } }; } };
}

test('GET /config/<key>: the config, the counter after this read, the threshold', async () => {
  const ddb = stubDdb(3);
  const app = buildApp({ ddb, tableName: 'HotKeys' });
  const res = await app.inject({ method: 'GET', url: '/config/acme' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.json(), { config: lookup('acme'), hits: 3, threshold: THRESHOLD });
  assert.equal(ddb.calls.length, 1);
  const input = ddb.calls[0];
  const { pk } = counterItem('acme', Math.floor(Date.now() / 1000));
  assert.equal(input.TableName, 'HotKeys');
  assert.deepEqual(input.Key, { pk: { S: pk } });
  assert.equal(input.UpdateExpression, 'ADD hits :one SET #ttl = :ttl');
  assert.equal(input.ReturnValues, 'UPDATED_NEW');
});

test('an unknown valid key gets the free plan', async () => {
  const res = await buildApp({ ddb: stubDdb(1) }).inject({ url: '/config/anything-else' });
  assert.deepEqual(res.json().config, { plan: 'free', model: 'small', rateLimit: 10 });
});

test('an invalid key: 400 and no counter write', async () => {
  const ddb = stubDdb();
  const app = buildApp({ ddb });
  for (const key of ['Acme', 'a_b', 'a'.repeat(33)]) {
    const res = await app.inject({ url: '/config/' + key });
    assert.equal(res.statusCode, 400, key);
    assert.match(res.json().error, /1-32 characters/);
  }
  assert.equal(ddb.calls.length, 0);
});

test('a failed counter write still serves the config, with hits null', async () => {
  const ddb = { send: async () => { throw new Error('throttled'); } };
  const res = await buildApp({ ddb }).inject({ url: '/config/globex' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { config: lookup('globex'), hits: null, threshold: THRESHOLD });
});

test('the forwarded request: echoes only x-config-* headers, path without the query', async () => {
  const ddb = stubDdb();
  const res = await buildApp({ ddb }).inject({
    url: '/patterns/kvs-config-plus-fetch/acme?a=1',
    headers: { 'x-config': '{"plan":"enterprise"}', 'x-config-source': 'kvs', 'x-other': 'no' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    path: '/patterns/kvs-config-plus-fetch/acme',
    headersFromFunction: { 'x-config': '{"plan":"enterprise"}', 'x-config-source': 'kvs' },
  });
  assert.equal(ddb.calls.length, 0, 'the echo never counts');
});

test('paths that are not exactly /config/<key> are echoed, not counted', async () => {
  const ddb = stubDdb();
  const app = buildApp({ ddb });
  for (const url of ['/config/', '/config/a/b']) {
    const res = await app.inject({ url });
    assert.equal(res.statusCode, 200, url);
    assert.equal(res.json().path, url);
  }
  assert.equal(ddb.calls.length, 0);
});
