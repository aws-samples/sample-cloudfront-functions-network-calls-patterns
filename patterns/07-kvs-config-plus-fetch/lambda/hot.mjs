// Hot-key promotion for 07-kvs-config-plus-fetch: pure logic, shared by origin.mjs and promoter.mjs.
// A key is hot when it reaches THRESHOLD origin reads inside one fixed window of WINDOW_SECONDS.
// A promoted key lives in KVS for PROMOTE_SECONDS, then the function treats it as a miss again.
export const THRESHOLD = Number(process.env.HOT_THRESHOLD ?? 5);
export const WINDOW_SECONDS = Number(process.env.HOT_WINDOW_SECONDS ?? 60);
export const PROMOTE_SECONDS = Number(process.env.PROMOTE_SECONDS ?? 600);
export const KVS_PREFIX = 'cfg-'; // the KVS is shared: every key this pattern writes starts with it
const MAX_VALUE_BYTES = 1024; // KVS limit per value

export const isValidKey = (key) => /^[a-z0-9-]{1,32}$/.test(key);

// One counter item per key per window. It expires one window after the window closes.
export function counterItem(key, now) {
  const window = Math.floor(now / WINDOW_SECONDS);
  return { pk: `hits#${key}#${window}`, ttl: (window + 2) * WINDOW_SECONDS };
}

// DynamoDB stream records -> what to write.
//   counter hits#<key>#<window> reaching THRESHOLD -> a marker item kvs#<key>, holding the KVS value, TTL = its expiry
//   marker INSERT or MODIFY                        -> put cfg-<key> in KVS
//   marker REMOVE (DynamoDB TTL)                   -> delete cfg-<key> from KVS
// The marker is the one record per key that KVS mirrors, so puts and deletes for a key arrive in order.
// Exactly one request per window sees hits === THRESHOLD, so a key is promoted at most once per window.
export function planStream(records, now, lookup) {
  const markers = [];
  const ops = new Map(); // KVS key -> { value } or null for a delete; the last record for a key wins
  for (const r of records) {
    const image = r.dynamodb?.NewImage ?? r.dynamodb?.OldImage;
    const pk = image?.pk?.S ?? '';
    const counter = /^hits#([a-z0-9-]+)#\d+$/.exec(pk);
    if (counter && r.eventName !== 'REMOVE' && Number(image.hits?.N) === THRESHOLD) {
      const exp = now + PROMOTE_SECONDS;
      const value = JSON.stringify({ exp, config: lookup(counter[1]) });
      if (Buffer.byteLength(value) <= MAX_VALUE_BYTES) markers.push({ pk: 'kvs#' + counter[1], ttl: exp, value });
    } else if (pk.startsWith('kvs#')) {
      const key = KVS_PREFIX + pk.slice(4);
      ops.set(key, r.eventName === 'REMOVE' ? null : { value: image.value.S });
    }
  }
  const puts = [];
  const deletes = [];
  for (const [key, op] of ops) (op ? puts.push({ key, value: op.value }) : deletes.push({ key }));
  return { markers, puts, deletes };
}
