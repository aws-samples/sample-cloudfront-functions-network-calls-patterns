// Turns a batch of DynamoDB stream records into one KVS write plan.
//   REMOVE (TTL expiry or delete) -> delete the key   = eviction
//   INSERT (a new assignment)                         -> put the value    = the lazy fill
//   MODIFY (variant changed, ttl extended, override)  -> put the new value = invalidation
// The stream is the only KVS writer: the loader (a Lambda Web Function) only writes DynamoDB.
// Later records win over earlier ones for the same uid.
export function planChanges(records) {
  const puts = new Map();
  const deletes = new Set();
  for (const r of records) {
    const uid = r.dynamodb && r.dynamodb.Keys && r.dynamodb.Keys.uid && r.dynamodb.Keys.uid.S;
    if (!uid) continue;
    if (r.eventName === 'REMOVE') {
      puts.delete(uid);
      deletes.add(uid);
    } else if (r.eventName === 'INSERT' || r.eventName === 'MODIFY') {
      const image = r.dynamodb.NewImage || {};
      const variant = image.variant && image.variant.S;
      if (variant !== 'A' && variant !== 'B') continue;
      deletes.delete(uid);
      puts.set(uid, variant);
    }
  }
  return {
    puts: [...puts].map(([key, value]) => ({ key, value })),
    deletes: [...deletes].map((key) => ({ key })),
  };
}
