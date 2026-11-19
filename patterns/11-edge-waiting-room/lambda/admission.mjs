// Admission logic for pattern 11, kept free of AWS clients so it can be unit tested.
// Once a tick: read the operator's knobs and the ticket counters, raise the watermark by STEP,
// and publish one KVS key the function reads: queue-state = { mode, epoch, serving, step, tick }.

export const SHARDS = 8; // the function draws tickets from the same number of counter items

// Tickets drawn so far, as "highest ticket + 1". Shard s with counter n issued ticket (n - 1) * SHARDS + s.
export function issued(counts) {
  let max = 0;
  counts.forEach((n, shard) => {
    if (n > 0) max = Math.max(max, (n - 1) * SHARDS + shard + 1);
  });
  return max;
}

// Move the watermark past `step` tickets that are still waiting: tickets in `left` (freed with
// /leave) are skipped, so a departed place doesn't waste a slot. Never past `cap`, the tickets drawn.
// Idempotent: `left` only grows, and tickets below the watermark are never looked at again.
export function advance(serving, step, cap, left) {
  let s = serving;
  for (let admitted = 0; s < cap && admitted < step; s++) if (!left.has(s)) admitted++;
  while (s < cap && left.has(s)) s++; // a run of departures right after: skip it too
  return s;
}

// Tickets below `serving` are admitted. It never passes the tickets actually drawn, so a quiet
// queue can't bank admissions for the next spike, and a new epoch starts again from 0.
// `resume`: queue-state is missing, so this is a new, empty KVS (every deploy replaces it) while the
// DynamoDB counters live on. Start at the tickets already drawn, not at 0, or new visitors would queue
// behind tickets nobody holds any more. (No ticket is drawn before queue-state exists, and the new KVS
// gets a new secret, so every old cookie is void anyway.)
export function nextState({ previous, mode, epoch, counts, left = new Set(), step, now, resume = false }) {
  const start = resume ? issued(counts) : 0;
  const serving = previous && previous.epoch === epoch ? previous.serving : start;
  return { mode, epoch, serving: advance(serving, step, issued(counts), left), step, tick: now };
}

// Demo only: `need` simulated visitors, as tickets added to the emptiest shards first (keeps the
// shards level). A visitor's position is ticket - serving, so these never move anyone back.
export function arrivals(counts, need) {
  const level = counts.slice();
  const add = counts.map(() => 0);
  for (let i = 0; i < need; i++) {
    const shard = level.indexOf(Math.min(...level));
    level[shard]++;
    add[shard]++;
  }
  return add;
}

// getKey(key) -> string or null; getCounts(epoch) -> [n per shard]; getLeft(epoch) -> [tickets freed
// with /leave]; updateKeys({ puts });
// randomSecret() -> a new HMAC secret, written only when queue-secret-cur is missing.
// demoLine > 0 (demo only): after each tick, top the line up to that many waiting visitors with
// addTickets(epoch, [n per shard]), so a real visitor watches the line move.
export function makeHandler({ getKey, getCounts, getLeft = async () => [], updateKeys, randomSecret, addTickets, demoLine = 0, step, now = () => Date.now() }) {
  return async () => {
    const [mode, epochValue, stateValue, secret] = await Promise.all(
      ['queue-mode', 'queue-epoch', 'queue-state', 'queue-secret-cur'].map(getKey));
    const epoch = Number.parseInt(epochValue, 10) > 0 ? Number.parseInt(epochValue, 10) : 1;
    let previous = null;
    try {
      previous = JSON.parse(stateValue);
    } catch {
      // no state yet: the first tick
    }
    const [counts, freed] = await Promise.all([getCounts(epoch), getLeft(epoch)]);
    const left = new Set(freed);
    const resume = stateValue === null || stateValue === undefined;
    const state = nextState({ previous, mode: mode === 'off' ? 'off' : 'on', epoch, counts, left, step, now: now(), resume });
    const puts = [{ key: 'queue-state', value: JSON.stringify(state) }];
    if (!secret) puts.push({ key: 'queue-secret-cur', value: randomSecret() });
    await updateKeys({ puts });
    const waiting = issued(counts) - state.serving - freed.filter((t) => t >= state.serving).length;
    const simulated = demoLine > 0 ? Math.max(0, demoLine - waiting) : 0;
    if (simulated > 0) await addTickets(epoch, arrivals(counts, simulated));
    console.log(JSON.stringify({ ...state, issued: issued(counts), left: left.size, simulated, seededSecret: !secret }));
    return state;
  };
}
