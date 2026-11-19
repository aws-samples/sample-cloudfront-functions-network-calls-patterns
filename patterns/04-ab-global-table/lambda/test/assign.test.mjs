import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidUid, variantFor, newItem, TTL_SECONDS } from '../assign.mjs';

test('uid must be 16 lowercase hex chars', () => {
  assert.equal(isValidUid('0123456789abcdef'), true);
  assert.equal(isValidUid('0123456789ABCDEF'), false);
  assert.equal(isValidUid('0123456789abcde'), false);
  assert.equal(isValidUid('../etc/passwd'), false);
  assert.equal(isValidUid(undefined), false);
});

test('variant is deterministic and roughly balanced', () => {
  const uid = '0123456789abcdef';
  assert.equal(variantFor(uid), variantFor(uid));
  let a = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) if (variantFor(i.toString(16).padStart(16, '0')) === 'A') a++;
  assert.ok(Math.abs(a / n - 0.5) < 0.02, `A share ${a / n} is not near 0.5`);
});

test('new item carries variant, assignedAt and a 24h ttl', () => {
  const item = newItem('0123456789abcdef', 1_000_000);
  assert.equal(item.uid.S, '0123456789abcdef');
  assert.ok(['A', 'B'].includes(item.variant.S));
  assert.equal(item.assignedAt.N, '1000000');
  assert.equal(item.ttl.N, String(1_000_000 + TTL_SECONDS));
  assert.equal(TTL_SECONDS, 86400);
});
