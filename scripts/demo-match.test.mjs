// node --test scripts/demo-match.test.mjs
// The demo matches demo.json "when" patterns with its own small matcher (demo/sequence.js
// matchPattern), never by compiling them with RegExp. Every pattern a pattern ships must
// read the same as the regex it looks like, captures included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchPattern } from '../demo/sequence.js';

const patterns = JSON.parse(readFileSync('demo/patterns.json', 'utf8'));

const shipped = new Set();
for (const p of patterns) {
  for (const o of p.outcomes ?? []) for (const re of [...Object.values(o.when?.headers ?? {}), ...Object.values(o.when?.json ?? {})]) shipped.add(re);
  for (const r of p.requests ?? []) {
    for (const st of r.frame?.states ?? []) {
      const w = st.when ?? {};
      for (const re of [w.title, w.text, ...Object.values(w.json ?? {})]) if (re !== undefined) shipped.add(re);
    }
  }
}

const samples = [
  '', 'x', 'ok', 'OK', 'ok ', ' ok', 'okay', 'kvs', 'kvs-stale', 'origin', 'fallback', 'default', 'skipped',
  'blue', 'GREEN', 'blueish', 'none', 'off', 'unavailable', 'unavailable: timeout', 'off-peak', 'acme', 'globex',
  'admin', 'viewer', 'demo-user', 'Demo-User', 'missing_token', 'invalid_token', 'forbidden', 'admitted', 'left',
  'browsers-only', 'served', 'queued', 'reset', 'beacon', '3/3', '12/12', '3/4', '12/1', '/', 'Paused', 'starting up',
  'Busy right now', 'not Busy', 'Your ticket is 42', 'your TICKET is 7 of 9', 'Your ticket is ',
  'Position about 12, roughly 3 min', 'Position about 1, roughly 10 minutes left', 'Position about x, roughly 3 min',
  '0f8fad5b-d9cb-469f-a165-70867728950e', '0F8FAD5B-D9CB-469F-A165-70867728950E', '0f8fad5b-d9cb-469f-a165-70867728950',
  'zf8fad5b-d9cb-469f-a165-70867728950e', 'line\nbreak',
];

test('the demo ships "when" patterns', () => assert.ok(shipped.size > 0));

for (const re of shipped) {
  test(`"${re}" reads like the regex`, () => {
    const regex = new RegExp(re, 'i');
    for (const s of samples) assert.deepEqual(matchPattern(re, s), regex.exec(s)?.slice() ?? null, `on "${s}"`);
  });
}

test('the matcher refuses what it does not know', () => {
  for (const bad of ['(?:a)', 'a**', '[a-', '(a', 'a)', '\\q', '^a|b$', 'a^']) assert.throws(() => matchPattern(bad, 'a'), undefined, bad);
});

test('the matcher takes counts, sets, classes and groups', () => {
  assert.deepEqual(matchPattern('^a{2,3}$', 'aaa'), ['aaa']);
  assert.equal(matchPattern('^a{2,3}$', 'aaaa'), null);
  assert.deepEqual(matchPattern('x(\\d+)?y', 'xy'), ['xy', undefined]);
  // No backtracking: \w+ takes the y, so the y after it finds nothing (a regex would give it back).
  assert.equal(matchPattern('x\\w+y', 'xay'), null);
  assert.deepEqual(matchPattern('^[^a-c]', 'D'), ['D']);
  assert.equal(matchPattern('^[^a-c]', 'B'), null);
  assert.deepEqual(matchPattern('^(a|bc)+$', 'abca'), ['abca', 'a']);
  assert.deepEqual(matchPattern('\\s\\.\\d', 'v 1 .5'), [' .5']);
});
