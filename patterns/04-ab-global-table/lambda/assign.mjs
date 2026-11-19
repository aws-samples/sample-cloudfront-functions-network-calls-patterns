// Pure assignment rules, shared by the loader and its tests.

export const TTL_SECONDS = 24 * 60 * 60;
const UID = /^[a-f0-9]{16}$/;

export const isValidUid = (uid) => typeof uid === 'string' && UID.test(uid);

// FNV-1a 32-bit, then % 2. Deterministic: the same uid always lands on the
// same side, so the first assignment needs no coordination between regions.
export function variantFor(uid) {
  let h = 0x811c9dc5;
  for (let i = 0; i < uid.length; i++) {
    h ^= uid.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 2 === 0 ? 'A' : 'B';
}

// The DynamoDB item for a fresh assignment.
export function newItem(uid, nowSeconds) {
  return {
    uid: { S: uid },
    variant: { S: variantFor(uid) },
    assignedAt: { N: String(nowSeconds) },
    ttl: { N: String(nowSeconds + TTL_SECONDS) },
  };
}
