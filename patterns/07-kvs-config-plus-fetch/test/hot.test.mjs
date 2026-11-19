// node --test patterns/07-kvs-config-plus-fetch/test
// The promotion logic the origin and the promoter share (lambda/hot.mjs). No AWS SDK needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THRESHOLD, WINDOW_SECONDS, PROMOTE_SECONDS, counterItem, isValidKey, planStream } from '../lambda/hot.mjs';
import { lookup } from '../lambda/source.mjs';

const NOW = 1_800_000_000;
const counter = (eventName, key, hits) => ({ eventName, dynamodb: { NewImage: { pk: { S: `hits#${key}#${Math.floor(NOW / WINDOW_SECONDS)}` }, hits: { N: String(hits) } } } });
const marker = (eventName, key, value) => eventName === 'REMOVE'
  ? { eventName, dynamodb: { OldImage: { pk: { S: 'kvs#' + key }, value: { S: value } } } }
  : { eventName, dynamodb: { NewImage: { pk: { S: 'kvs#' + key }, value: { S: value } } } };

test('defaults: 5 reads in a 60 s window promote for 10 minutes', () => {
  assert.equal(THRESHOLD, 5);
  assert.equal(WINDOW_SECONDS, 60);
  assert.equal(PROMOTE_SECONDS, 600);
});

test('counterItem: one item per key per window, kept one window past its end', () => {
  const a = counterItem('acme', 120);
  assert.deepEqual(a, { pk: 'hits#acme#2', ttl: 240 });
  assert.equal(counterItem('acme', 179).pk, a.pk, 'same window');
  assert.notEqual(counterItem('acme', 180).pk, a.pk, 'next window');
});

test('isValidKey', () => {
  for (const k of ['acme', 'tenant-42', 'a'.repeat(32)]) assert.ok(isValidKey(k), k);
  for (const k of ['', 'Acme', 'a_b', 'a/b', 'a'.repeat(33)]) assert.ok(!isValidKey(k), k);
});

test('a counter reaching THRESHOLD becomes a marker holding the KVS value; others do nothing', () => {
  const plan = planStream([
    counter('INSERT', 'acme', 1),
    counter('MODIFY', 'acme', THRESHOLD - 1),
    counter('MODIFY', 'acme', THRESHOLD),
    counter('MODIFY', 'acme', THRESHOLD + 1),
    counter('REMOVE', 'globex', THRESHOLD), // a counter's own TTL expiry
  ], NOW, lookup);
  assert.deepEqual(plan.puts, []);
  assert.deepEqual(plan.deletes, []);
  assert.equal(plan.markers.length, 1);
  const [m] = plan.markers;
  assert.equal(m.pk, 'kvs#acme');
  assert.equal(m.ttl, NOW + PROMOTE_SECONDS);
  assert.deepEqual(JSON.parse(m.value), { exp: NOW + PROMOTE_SECONDS, config: lookup('acme') });
});

test('a marker write puts cfg-<key> in KVS; its TTL removal deletes it', () => {
  const plan = planStream([marker('INSERT', 'acme', '{"exp":1}'), marker('REMOVE', 'globex', '{"exp":2}')], NOW, lookup);
  assert.deepEqual(plan.puts, [{ key: 'cfg-acme', value: '{"exp":1}' }]);
  assert.deepEqual(plan.deletes, [{ key: 'cfg-globex' }]);
  assert.deepEqual(plan.markers, []);
});

test('several records for one key: the last wins, never a put and a delete together', () => {
  const plan = planStream([
    marker('REMOVE', 'acme', '{"exp":1}'),
    marker('INSERT', 'acme', '{"exp":2}'),
    marker('MODIFY', 'globex', '{"exp":3}'),
    marker('REMOVE', 'globex', '{"exp":3}'),
  ], NOW, lookup);
  assert.deepEqual(plan.puts, [{ key: 'cfg-acme', value: '{"exp":2}' }]);
  assert.deepEqual(plan.deletes, [{ key: 'cfg-globex' }]);
});

test('a value over the 1 KB KVS limit is not promoted', () => {
  const plan = planStream([counter('MODIFY', 'acme', THRESHOLD)], NOW, () => ({ blob: 'x'.repeat(1100) }));
  assert.deepEqual(plan.markers, []);
});

test('source: known keys have their config, any other valid key gets the free plan', () => {
  assert.equal(lookup('acme').plan, 'enterprise');
  assert.deepEqual(lookup('anything-else'), { plan: 'free', model: 'small', rateLimit: 10 });
});
