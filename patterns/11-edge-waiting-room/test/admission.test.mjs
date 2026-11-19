// node --test patterns/11-edge-waiting-room/test
// The admission Lambda's logic (lambda/admission.mjs) with fake KVS and DynamoDB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHARDS, advance, arrivals, issued, makeHandler, nextState } from '../lambda/admission.mjs';

test('issued: highest ticket + 1 across shards; empty shards count as nothing', () => {
  assert.equal(SHARDS, 8);
  assert.equal(issued(new Array(8).fill(0)), 0);
  assert.equal(issued([1, 0, 0, 0, 0, 0, 0, 0]), 1); // ticket 0
  assert.equal(issued([0, 0, 0, 0, 0, 0, 0, 1]), 8); // ticket 7
  assert.equal(issued([3, 2, 0, 0, 0, 0, 0, 0]), 17); // tickets 0, 8, 16 and 1, 9
});

test('nextState: the watermark rises by STEP but never passes the tickets drawn', () => {
  const counts = [10, 10, 10, 10, 10, 10, 10, 10]; // 80 tickets
  const s1 = nextState({ previous: null, mode: 'on', epoch: 1, counts, step: 30, now: 1 });
  assert.deepEqual(s1, { mode: 'on', epoch: 1, serving: 30, step: 30, tick: 1 });
  const s2 = nextState({ previous: s1, mode: 'on', epoch: 1, counts, step: 30, now: 2 });
  assert.equal(s2.serving, 60);
  const s3 = nextState({ previous: s2, mode: 'on', epoch: 1, counts, step: 30, now: 3 });
  assert.equal(s3.serving, 80, 'capped at the tickets drawn: a quiet queue banks nothing');
});

test('nextState: a new epoch starts again from 0', () => {
  const previous = { mode: 'on', epoch: 1, serving: 500, step: 30, tick: 1 };
  const s = nextState({ previous, mode: 'on', epoch: 2, counts: [5, 0, 0, 0, 0, 0, 0, 0], step: 30, now: 2 });
  assert.equal(s.serving, 30, 'from 0, not from the old epoch at 500');
  assert.equal(s.epoch, 2);
});

test('arrivals: simulated tickets go to the emptiest shards first', () => {
  assert.deepEqual(arrivals([2, 1, 1, 2, 2, 2, 2, 2], 3), [1, 1, 1, 0, 0, 0, 0, 0]); // 1 and 2 first, then level: shard 0
  assert.deepEqual(arrivals(new Array(8).fill(0), 0), new Array(8).fill(0));
});

function fakes({ keys = {}, counts = new Array(8).fill(4), demoLine = 0, left = [] } = {}) {
  const calls = { counts: [], puts: [], added: [] };
  return {
    calls,
    deps: {
      getKey: async (k) => (k in keys ? keys[k] : null),
      getCounts: async (epoch) => { calls.counts.push(epoch); return counts; },
      getLeft: async () => left,
      updateKeys: async ({ puts }) => { calls.puts.push(...puts); },
      randomSecret: () => 'new-secret',
      addTickets: async (epoch, add) => { calls.added.push({ epoch, add }); },
      demoLine,
      step: 10,
      now: () => 1000,
    },
  };
}

test('first tick: defaults (on, epoch 1), publishes queue-state and seeds the HMAC secret', async () => {
  const { calls, deps } = fakes({ keys: { 'queue-state': 'not json' } }); // present but unreadable: start from 0
  const state = await makeHandler(deps)();
  assert.deepEqual(state, { mode: 'on', epoch: 1, serving: 10, step: 10, tick: 1000 });
  assert.deepEqual(calls.counts, [1]);
  assert.deepEqual(calls.puts, [
    { key: 'queue-state', value: JSON.stringify(state) },
    { key: 'queue-secret-cur', value: 'new-secret' },
  ]);
});

test('later tick: reads the operator knobs, keeps the existing secret, continues the watermark', async () => {
  const previous = { mode: 'on', epoch: 3, serving: 20, step: 10, tick: 1 };
  const { calls, deps } = fakes({ keys: {
    'queue-mode': 'off', 'queue-epoch': '3', 'queue-state': JSON.stringify(previous), 'queue-secret-cur': 'kept',
  } });
  const state = await makeHandler(deps)();
  assert.deepEqual(state, { mode: 'off', epoch: 3, serving: 30, step: 10, tick: 1000 });
  assert.deepEqual(calls.counts, [3]);
  assert.equal(calls.puts.length, 1, 'no secret write');
});

test('a bad queue-epoch or queue-state falls back to epoch 1 and serving 0', async () => {
  const { deps } = fakes({ keys: { 'queue-epoch': 'soon', 'queue-state': '{not json', 'queue-secret-cur': 'k' } });
  const state = await makeHandler(deps)();
  assert.equal(state.epoch, 1);
  assert.equal(state.serving, 10);
});

test('demo line: after the watermark moves, simulated visitors top the line up to DEMO_LINE', async () => {
  // 32 tickets drawn (4 per shard), serving moves 0 -> 10, so 22 wait: no top-up needed for a line of 20.
  const state0 = JSON.stringify({ mode: 'on', epoch: 1, serving: 0, step: 10, tick: 1 });
  const a = fakes({ demoLine: 20, keys: { 'queue-state': state0 } });
  await makeHandler(a.deps)();
  assert.deepEqual(a.calls.added, []);
  // A line of 30: 8 more, one per shard, all added to the same epoch's counters.
  const b = fakes({ demoLine: 30, keys: { 'queue-state': state0 } });
  const state = await makeHandler(b.deps)();
  assert.equal(state.serving, 10);
  assert.deepEqual(b.calls.added, [{ epoch: 1, add: [1, 1, 1, 1, 1, 1, 1, 1] }]);
});

test('no demo line by default: nothing simulated', async () => {
  const { calls, deps } = fakes({ counts: new Array(8).fill(0) });
  await makeHandler(deps)();
  assert.deepEqual(calls.added, []);
});

test('advance: STEP remaining tickets, departed ones skipped, capped at the tickets drawn', () => {
  assert.equal(advance(10, 5, 100, new Set()), 15);
  assert.equal(advance(10, 5, 100, new Set([11, 13])), 17, 'two left in range: two more admitted');
  assert.equal(advance(10, 5, 100, new Set([3, 4])), 15, 'left below the watermark change nothing');
  assert.equal(advance(10, 5, 12, new Set([11])), 12, 'never past the tickets drawn');
  assert.equal(advance(10, 2, 100, new Set([10, 11, 12])), 15, 'a run of departures is skipped whole');
});

test('leaves are idempotent: the same set, ticked again from the new watermark, skips nothing twice', () => {
  const left = new Set([11, 13]);
  const s1 = advance(10, 5, 100, left);
  assert.equal(advance(s1, 5, 100, left), s1 + 5);
});

test('tick: departed tickets (from the number set) are skipped, and the demo line counts only who still waits', async () => {
  const previous = { mode: 'on', epoch: 1, serving: 0, step: 10, tick: 1 };
  const { calls, deps } = fakes({ keys: { 'queue-state': JSON.stringify(previous), 'queue-secret-cur': 'k' }, left: [2, 5, 20], demoLine: 25 });
  const state = await makeHandler(deps)();
  assert.equal(state.serving, 12, 'tickets 0-11 minus 2 and 5: 10 admitted');
  // 32 drawn, serving 12, ticket 20 left: 19 still wait, so 6 simulated visitors top the line up to 25.
  assert.equal(calls.added[0].add.reduce((a, b) => a + b, 0), 6);
});

test('nextState: no previous state (a new, empty KVS) resumes at the tickets drawn, not at 0', () => {
  const counts = new Array(SHARDS).fill(500); // the DynamoDB counters outlive a KVS replacement
  const s = nextState({ previous: null, mode: 'on', epoch: 1, counts, step: 30, now: 1, resume: true });
  assert.equal(s.serving, issued(counts), 'everyone who drew a ticket before the reset is already past the watermark');
  const fresh = nextState({ previous: null, mode: 'on', epoch: 1, counts: new Array(SHARDS).fill(0), step: 30, now: 1, resume: true });
  assert.equal(fresh.serving, 0, 'a first deploy, with no tickets drawn, still starts at 0');
});

test('nextState: a new epoch with previous state still starts again from 0', () => {
  const s = nextState({ previous: { epoch: 1, serving: 900 }, mode: 'on', epoch: 2, counts: new Array(SHARDS).fill(0), step: 30, now: 1 });
  assert.equal(s.serving, 0);
});

test('a missing queue-state (a new KVS after a deploy) resumes at the tickets already drawn', async () => {
  const { deps } = fakes(); // 32 tickets drawn in DynamoDB, no queue-state in KVS
  const state = await makeHandler(deps)();
  assert.equal(state.serving, 32);
});
