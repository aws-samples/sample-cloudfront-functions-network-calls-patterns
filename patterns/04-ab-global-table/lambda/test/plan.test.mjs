import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planChanges } from '../plan.mjs';

const rec = (eventName, uid, variant) => ({
  eventName,
  dynamodb: { Keys: { uid: { S: uid } }, NewImage: variant ? { uid: { S: uid }, variant: { S: variant } } : undefined },
});

test('INSERT fills, MODIFY rewrites, REMOVE evicts', () => {
  const plan = planChanges([rec('INSERT', 'u1', 'A'), rec('MODIFY', 'u2', 'B'), rec('REMOVE', 'u3')]);
  assert.deepEqual(plan, { puts: [{ key: 'u1', value: 'A' }, { key: 'u2', value: 'B' }], deletes: [{ key: 'u3' }] });
});

test('the last record for a uid wins', () => {
  assert.deepEqual(planChanges([rec('MODIFY', 'u1', 'A'), rec('REMOVE', 'u1')]), { puts: [], deletes: [{ key: 'u1' }] });
  assert.deepEqual(planChanges([rec('REMOVE', 'u1'), rec('MODIFY', 'u1', 'B')]), { puts: [{ key: 'u1', value: 'B' }], deletes: [] });
});

test('garbage records are skipped', () => {
  assert.deepEqual(planChanges([{ eventName: 'MODIFY' }, rec('MODIFY', 'u1', 'C'), { eventName: 'REMOVE', dynamodb: {} }]), { puts: [], deletes: [] });
});
