// CloudFront's Server-Timing header, read for the demo's response panel and replay.
// Metrics (CloudFront Developer Guide, "Server-Timing header"): cdn-cache-hit,
// cdn-cache-refresh, cdn-cache-miss (flags); cdn-pop, cdn-rid, cdn-hit-layer,
// cdn-upstream-layer (desc); cdn-upstream-dns, cdn-upstream-connect, cdn-upstream-fbl,
// cdn-downstream-fbl (dur, ms). An origin's own entries may sit among them, so names
// this page does not know are kept but not drawn.

// "a;dur=1,b;desc=\"x, y\",c" -> Map { a => { dur: 1 }, b => { desc: 'x, y' }, c => {} }
export function parseServerTiming(header) {
  const out = new Map();
  if (!header) return out;
  for (const part of header.match(/(?:[^,"]|"[^"]*")+/g) ?? []) {
    const [name, ...params] = (part.match(/(?:[^;"]|"[^"]*")+/g) ?? []).map((s) => s.trim());
    if (!name) continue;
    const entry = {};
    for (const p of params) {
      const [k, ...v] = p.split('=');
      const value = v.join('=').trim().replace(/^"(.*)"$/, '$1');
      if (k.trim() === 'dur' && value !== '' && Number.isFinite(Number(value))) entry.dur = Number(value);
      else if (k.trim() === 'desc') entry.desc = value;
    }
    out.set(name, entry);
  }
  return out;
}

// The same Map from a PerformanceResourceTiming entry's serverTiming list (the fallback
// when the header itself is not readable). The API reports a missing dur as 0.
export function fromPerformance(list = []) {
  const out = new Map();
  for (const t of list) out.set(t.name, { dur: t.duration, ...(t.description ? { desc: t.description } : {}) });
  return out;
}

// What the page says about one reply. null when there is nothing to say.
export function readTiming(m) {
  if (!m || !m.size) return null;
  const dur = (n) => m.get(n)?.dur;
  const desc = (n) => m.get(n)?.desc;
  const cache = m.has('cdn-cache-hit') ? 'hit' : m.has('cdn-cache-refresh') ? 'refresh' : m.has('cdn-cache-miss') ? 'miss' : null;
  const origin = ['cdn-upstream-dns', 'cdn-upstream-connect', 'cdn-upstream-fbl'].some((n) => m.has(n))
    ? { dns: dur('cdn-upstream-dns') ?? 0, connect: dur('cdn-upstream-connect') ?? 0, firstByte: dur('cdn-upstream-fbl') ?? 0, layer: desc('cdn-upstream-layer') }
    : null;
  return { edge: dur('cdn-downstream-fbl'), cache, hitLayer: desc('cdn-hit-layer'), origin, pop: desc('cdn-pop'), rid: desc('cdn-rid') };
}
