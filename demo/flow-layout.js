// The geometry of the "What happens" view, with no DOM, so the build and the tests
// can check it for every pattern. A pattern's sequence diagram becomes:
//  - routes: per diagram step, the stations it passes on CloudFront's own path;
//  - a graph: the stations, and the connectors (legs) the routes ride, each drawn once;
//  - a layout: a box per station on a fixed grid, and an orthogonal path per leg
//    that never crosses a box and never runs on top of another leg.
// The grid, left to right: the viewer; the edge location (TLS, WAF, the functions with
// KVS above them, the cache); the account (called services above, origins on the
// lanes, a called service of the viewer-response function below); what sits behind the
// origins; background workers in their own row under them. The request lane runs left
// to right through the viewer-request function, the reply lane comes back right to left
// through the viewer-response function.

// A function's message is a side call when it reads like one.
export const CALL_TEXT = /^(cf\.(fetch|beacon)\b|get\()/;
export const STAGES = ['viewer', 'waf', 'viewer-request', 'viewer-response', 'cache', 'origin', 'call', 'kvs', 'backend'];
// demo.json actors[id].lane: "background" draws a backend in the background row, and
// every leg that touches it as a background connector.
export const LANES = ['background'];

const isFunction = (at) => at === 'viewer-request' || at === 'viewer-response';

// demo.json actors[id].at says where a participant sits; without it, guess from the diagram label.
export function inferAt(x, i) {
  const label = x.label.toLowerCase();
  if (i === 0) return 'viewer';
  if (label.includes('viewer-request')) return 'viewer-request';
  if (label.includes('viewer-response')) return 'viewer-response';
  if (/\bwaf\b/.test(label)) return 'waf';
  if (/\bkvs\b/.test(label)) return 'kvs';
  if (label.includes('cache')) return 'cache';
  return 'origin';
}

const actorOf = (p, id) => {
  const a = p.actors?.[id];
  return typeof a === 'string' ? { name: a } : a ?? {};
};

// participant id -> where it sits on the loop.
export function placements(p, model) {
  return new Map(model.participants.map((x, i) => [x.id, actorOf(p, x.id).at ?? inferAt(x, i)]));
}

// One route per diagram step: the station keys it passes, in order, and the
// lane ('req' or 'res') it runs on where a station spans both lanes.
export function routes(p, model) {
  const at = placements(p, model);
  const atOf = (id) => at.get(id);
  const pending = new Map(); // function id -> the id it last called, until that one answers
  const seen = new Map(); // participant id -> the station key it was last at
  const home = (id) => {
    const a = atOf(id);
    if (a === 'viewer' || a === 'cache' || a === 'waf') return a;
    if (isFunction(a)) return a === 'viewer-request' ? 'vr' : 'vresp';
    return a === 'origin' || a === 'backend' ? `${a}:${id}` : `call-top:${id}`;
  };
  const where = (id) => seen.get(id) ?? home(id);
  return model.steps.map((s) => {
    if (s.kind === 'note') return { kind: 'note', keys: s.over.map(where) };
    if (s.from === s.to) return { kind: 'self', keys: [where(s.from)] };
    const a = atOf(s.from);
    const b = atOf(s.to);
    if (isFunction(a) && b !== 'viewer' && b !== 'cache' && (CALL_TEXT.test(s.text) || b === 'call' || b === 'kvs')) {
      // A call goes straight to its target, not through the cache.
      const key = b === 'origin' ? `origin:${s.to}` : `${a === 'viewer-request' ? 'call-top' : 'call-bottom'}:${s.to}`;
      pending.set(s.from, s.to);
      seen.set(s.to, key);
      return { kind: 'call', keys: [home(s.from), key] };
    }
    if (isFunction(b) && pending.has(s.to) && (pending.get(s.to) === s.from || a === 'backend')) {
      const callee = pending.get(s.to);
      pending.delete(s.to);
      // The answer comes back the way the call went: through the called service when
      // what sits behind it answers (a counter behind the API).
      const via = callee === s.from ? [] : [where(callee)];
      return { kind: 'call-reply', keys: [where(s.from), ...via, home(s.to)] };
    }
    if (a === 'viewer' && b === 'viewer-request') return { kind: 'enter', keys: ['viewer', 'tls', 'waf', 'vr'], lane: 'req' };
    // A pattern whose diagram names AWS WAF: the request stops there, WAF answers or passes it on.
    if (a === 'viewer' && b === 'waf') return { kind: 'enter', keys: ['viewer', 'tls', 'waf'], lane: 'req' };
    if (a === 'waf' && b === 'viewer') return { kind: 'edge-answer', keys: ['waf', 'tls', 'viewer'], lane: 'res' };
    if (a === 'waf' && b === 'viewer-request') return { kind: 'enter', keys: ['waf', 'vr'], lane: 'req' };
    if (a === 'viewer-request' && b === 'viewer') return { kind: 'edge-answer', keys: ['vr', 'tls', 'viewer'], lane: 'res' };
    if (a === 'viewer-request' && b === 'cache') return { kind: 'forward', keys: ['vr', 'cache'], lane: 'req' };
    if (a === 'viewer-request' && b === 'origin') {
      seen.set(s.to, `origin:${s.to}`);
      return { kind: 'forward', keys: ['vr', 'cache', `origin:${s.to}`], lane: 'req' };
    }
    if ((a === 'origin' || a === 'cache') && (b === 'viewer' || b === 'viewer-response')) {
      const start = a === 'cache' ? ['cache'] : [`origin:${s.from}`, 'cache'];
      return { kind: 'reply', keys: b === 'viewer' ? [...start, 'tls', 'viewer'] : [...start, 'vresp'], lane: 'res' };
    }
    if (a === 'viewer-response' && b === 'viewer') return { kind: 'reply', keys: ['vresp', 'tls', 'viewer'], lane: 'res' };
    return { kind: 'direct', keys: [where(s.from), where(s.to)] };
  });
}

// ---------- The graph: stations, and the legs the routes ride ----------

const FN_KEYS = new Set(['vr', 'vresp']);
const idOf = (key) => key.slice(key.indexOf(':') + 1);

// The short name a connector carries: the network call, the KVS read, or the API the step names.
function legLabel(type, texts) {
  if (type === 'kvs') return 'KVS get';
  if (type === 'call') return [...new Set(texts.map((t) => /^cf\.(fetch|beacon)\b/.exec(t)?.[0]).filter(Boolean))].join(' · ') || 'call';
  for (const t of texts) {
    const api = /\b[A-Z][a-z]+(?:[A-Z][a-z]*)+\b/.exec(t);
    if (api) return api[0];
  }
  return '';
}

export function flowGraph(p, model, rs = routes(p, model)) {
  const at = placements(p, model);
  const background = new Set(model.participants.filter((x) => actorOf(p, x.id).lane === 'background').map((x) => x.id));
  const placeOf = (key) => {
    if (!key.includes(':')) return key;
    const id = idOf(key);
    if (key.startsWith('call-top:')) return at.get(id) === 'kvs' ? 'kvs' : 'call-top';
    if (key.startsWith('backend:')) return background.has(id) ? 'background' : 'backend';
    return key.slice(0, key.indexOf(':'));
  };
  const typeOf = (a, b, lane) => {
    if (lane) return lane;
    const fn = FN_KEYS.has(a) || FN_KEYS.has(b);
    if (fn) return placeOf(FN_KEYS.has(a) ? b : a) === 'kvs' ? 'kvs' : 'call';
    return placeOf(a) === 'background' || placeOf(b) === 'background' ? 'bg' : 'direct';
  };
  // A lane leg runs one way; any other leg is drawn once for both directions.
  const legKey = (a, b, lane) => {
    const type = typeOf(a, b, lane);
    return { type, id: lane ? `${lane}:${a}>${b}` : `${type}:${[a, b].sort().join('|')}` };
  };
  const legs = new Map();
  // The legs one route rides, each with the direction it rides it in.
  const legsOf = (route) => {
    if (route.kind === 'note' || route.kind === 'self') return [];
    const out = [];
    for (let i = 1; i < route.keys.length; i++) {
      const a = route.keys[i - 1];
      const b = route.keys[i];
      if (a === b) continue;
      const { id } = legKey(a, b, route.lane);
      const leg = legs.get(id);
      out.push({ id, reverse: Boolean(leg) && leg.a !== a });
    }
    return out;
  };
  rs.forEach((route, i) => {
    const s = model.steps[i];
    if (route.kind === 'note' || route.kind === 'self') return;
    for (let k = 1; k < route.keys.length; k++) {
      const a = route.keys[k - 1];
      const b = route.keys[k];
      if (a === b) continue;
      const { id, type } = legKey(a, b, route.lane);
      let leg = legs.get(id);
      if (!leg) legs.set(id, (leg = { id, a, b, type, async: false, texts: [], steps: [], arrowA: false, arrowB: false }));
      if (leg.a === a) leg.arrowB = true;
      else leg.arrowA = true;
      if (!leg.steps.includes(i)) leg.steps.push(i);
      if (s.kind === 'message' && !s.reply) leg.texts.push(s.text);
      if (s.async) leg.async = true;
    }
  });
  for (const leg of legs.values()) leg.label = leg.type === 'req' || leg.type === 'res' ? '' : legLabel(leg.type, leg.texts);
  const keys = new Set(['viewer', 'tls', 'waf', 'vr', 'cache', ...rs.flatMap((r) => r.keys)]);
  const stations = [...keys].map((key) => ({ key, place: placeOf(key) }));
  return { stations, legs: [...legs.values()], legsOf, hasVresp: keys.has('vresp') };
}

// ---------- The layout ----------

const GAP = 56; // between columns: room for a few vertical tracks
const SIDE_GAP = 64; // between the side row (KVS, called services) and the request row
const ROW_GAP = 32; // between the request and the reply row
const BG_GAP = 96; // between the lanes and the background row
const STACK = 20; // between boxes stacked in one column
const TRACK = 10; // between parallel connectors
const CLEAR = 6; // how close a connector may pass a box it does not touch
const PAD = 16; // a group's padding around its boxes
const BAND = 30; // a group's label band
const COL = { viewer: 0, tls: 1, waf: 2, vr: 3, vresp: 3, kvs: 3, cache: 4, 'call-top': 5, origin: 5, 'call-bottom': 5, backend: 6, background: 6 };

const rect = (x, y, w, h) => ({ x, y, w, h, l: x, r: x + w, t: y, b: y + h, cx: x + w / 2, cy: y + h / 2 });

export function layoutFlow(graph, { w = 120, h = 100, labelWidth = defaultLabelWidth } = {}) {
  const boxes = new Map();
  const colX = (c) => c * (w + GAP);
  const of = (place) => graph.stations.filter((s) => s.place === place).map((s) => s.key);
  const hasSide = of('kvs').length + of('call-top').length > 0;
  const lanesTop = hasSide ? h + SIDE_GAP : 0;
  const reqTop = lanesTop;
  const resTop = lanesTop + h + ROW_GAP;
  const lanesBottom = resTop + h;
  const tall = lanesBottom - lanesTop;
  const put = (key, c, top, height = h) => boxes.set(key, { ...rect(colX(c), top, w, height), key });
  put('viewer', COL.viewer, lanesTop, tall);
  put('tls', COL.tls, lanesTop, tall);
  put('waf', COL.waf, reqTop);
  put('vr', COL.vr, reqTop);
  if (graph.hasVresp) put('vresp', COL.vresp, resTop);
  put('cache', COL.cache, lanesTop, tall);
  of('kvs').forEach((k, i) => put(k, COL.kvs - i, 0));
  of('call-top').forEach((k, i) => put(k, COL['call-top'], -i * (h + STACK)));
  // A column of boxes on the lanes: one spans both, two take a lane each, more stack below.
  const stack = (keys, c) => {
    if (keys.length === 1 && c === COL.origin) return put(keys[0], c, lanesTop, tall);
    if (keys.length === 1) return put(keys[0], c, lanesTop + (tall - h) / 2);
    keys.forEach((k, i) => put(k, c, i < 2 ? [reqTop, resTop][i] : resTop + (i - 1) * (h + STACK)));
  };
  stack(of('origin'), COL.origin);
  stack(of('backend'), COL.backend);
  let low = Math.max(...[...boxes.values()].map((b) => b.b));
  of('call-bottom').forEach((k, i) => put(k, COL['call-bottom'], low + SIDE_GAP + i * (h + STACK)));
  low = Math.max(...[...boxes.values()].map((b) => b.b));
  of('background').forEach((k, i) => put(k, COL.background + i, low + BG_GAP));
  const ghost = graph.hasVresp ? null : rect(colX(COL.vresp), resTop, w, h);
  // The missing viewer-response function is a caption under the reply lane, not a box.
  const captions = ghost ? [{ key: 'vresp', ...rect(ghost.x, ghost.cy + 14, w, 34) }] : [];

  const all = [...boxes.values()];
  const top = Math.min(...all.map((b) => b.t));
  const bottom = Math.max(...all.map((b) => b.b));
  const right = Math.max(...all.map((b) => b.r));
  // Channels: horizontal tracks above and below everything (outside the groups' label
  // bands), between the rows, and vertical tracks in the gaps between columns.
  const ys = [
    ...Array.from({ length: 6 }, (_, i) => top - PAD - BAND - 14 - i * TRACK),
    ...(hasSide ? [h + SIDE_GAP / 2, h + SIDE_GAP / 2 - TRACK, h + SIDE_GAP / 2 + TRACK] : []),
    ...Array.from({ length: 3 }, (_, i) => lanesBottom + 26 + i * TRACK),
    ...Array.from({ length: 4 }, (_, i) => bottom + PAD + BAND + 14 + i * TRACK),
  ];
  const cols = Math.max(...all.map((b) => Math.round(b.x / (w + GAP)))) + 1;
  const xs = [
    ...Array.from({ length: cols - 1 }, (_, c) => colX(c) + w + GAP / 2).flatMap((m) => [m, m - TRACK, m + TRACK, m - 2 * TRACK, m + 2 * TRACK]),
    ...Array.from({ length: 4 }, (_, i) => right + PAD + 14 + i * TRACK),
  ];

  // Groups depend on the boxes only, so they come first: their labels are obstacles too.
  const members = (keys) => keys.map((k) => boxes.get(k)).filter(Boolean);
  const around = (rs) => {
    const l = Math.min(...rs.map((r) => r.l)) - PAD;
    const t = Math.min(...rs.map((r) => r.t)) - PAD - BAND;
    const r = Math.max(...rs.map((x) => x.r)) + PAD;
    const b = Math.max(...rs.map((x) => x.b)) + PAD;
    return rect(l, t, r - l, b - t);
  };
  const groups = [{ kind: 'edge', label: 'CloudFront edge location', ...around([...members(['tls', 'waf', 'vr', 'vresp', 'cache', ...of('kvs')]), ...(ghost ? [ghost] : [])]) }];
  const bgBoxes = members(of('background'));
  const bgGroup = bgBoxes.length ? { kind: 'background', label: 'Background', ...around(bgBoxes) } : null;
  const accountBoxes = members([...of('call-top'), ...of('origin'), ...of('call-bottom'), ...of('backend')]);
  if (accountBoxes.length || bgGroup) groups.push({ kind: 'account', label: 'Your AWS account', ...around([...accountBoxes, ...(bgGroup ? [bgGroup] : [])]) });
  if (bgGroup) groups.push(bgGroup);
  for (const g of groups) {
    const lw = labelWidth(g.label, 'group');
    g.spots = [rect(g.l + 10, g.t + 6, lw, 18), rect(g.r - 10 - lw, g.t + 6, lw, 18)];
  }

  const lane = { req: reqTop + h / 2, res: resTop + h / 2 };
  const order = [...graph.legs].sort((a, b) => rank(a) - rank(b) || span(b) - span(a));
  function rank(leg) { return { req: 0, res: 1, kvs: 2, call: 3, direct: 4, bg: 5 }[leg.type]; }
  function span(leg) { return Math.abs(boxes.get(leg.a).cx - boxes.get(leg.b).cx); }
  const routeAll = (obstacles) => {
    const routed = []; // { id, segs }
    const paths = new Map();
    for (const leg of order) {
      const A = boxes.get(leg.a);
      const B = boxes.get(leg.b);
      const tiers = leg.type === 'req' || leg.type === 'res' ? [laneCandidates(A, B, lane[leg.type], xs)] : sideCandidates(A, B, xs, ys);
      let best = null;
      for (const cands of tiers) {
        for (const pts of cands) {
          const s = simplify(pts);
          const segs = segments(s);
          if (!segs.length || !valid(segs, A, B, obstacles)) continue;
          const score = cost(segs, routed);
          if (!best || score < best.score) best = { pts: s, segs, score };
        }
        if (best && best.score < 400) break;
      }
      if (!best) {
        // Never expected (the checker reports it): fall back to a dog-leg so the page still draws.
        const pts = [{ x: A.cx, y: A.cy }, { x: (A.cx + B.cx) / 2, y: A.cy }, { x: (A.cx + B.cx) / 2, y: B.cy }, { x: B.cx, y: B.cy }];
        best = { pts, segs: segments(pts) };
      }
      routed.push({ id: leg.id, segs: best.segs });
      paths.set(leg.id, best.pts);
    }
    return { routed, paths };
  };
  // A group label takes the top corner no connector crosses; when both are crossed it
  // keeps the left one and the connectors are routed again around it.
  let obstacles = [...all, ...captions];
  let { routed, paths } = routeAll(obstacles);
  const hit = (spot) => routed.some((r) => r.segs.some((sg) => segHitsRect(sg, spot, 2)));
  const forced = [];
  for (const g of groups) {
    g.labelBox = g.spots.find((spot) => !hit(spot));
    if (!g.labelBox) forced.push((g.labelBox = g.spots[0]));
  }
  if (forced.length) {
    obstacles = [...obstacles, ...forced.map((f, i) => ({ ...f, key: `group label ${i + 1}` }))];
    ({ routed, paths } = routeAll(obstacles));
  }

  // Connector labels: on a stretch of the leg clear of boxes, other labels and lines.
  const labels = [];
  for (const leg of graph.legs) {
    if (!leg.label && leg.type !== 'call' && leg.type !== 'kvs' && leg.type !== 'direct' && leg.type !== 'bg') continue;
    const lw = labelWidth(leg.label, leg.type, Math.min(leg.steps.length, 4));
    const segs = segments(paths.get(leg.id));
    let best = null;
    for (const sg of segs) {
      const len = Math.abs(sg.x2 - sg.x1) + Math.abs(sg.y2 - sg.y1);
      for (const t of [0.5, 0.3, 0.7, 0.15, 0.85]) {
        const cx = sg.x1 + (sg.x2 - sg.x1) * t;
        const cy = sg.y1 + (sg.y2 - sg.y1) * t;
        const box = rect(cx - lw / 2, cy - 9, lw, 18);
        if (obstacles.some((o) => overlaps(box, o, 3)) || labels.some((o) => overlaps(box, o.box, 4)) || groups.some((g) => overlaps(box, g.labelBox, 3))) continue;
        const cuts = routed.filter((r) => r.id !== leg.id).flatMap((r) => r.segs).filter((s) => segHitsRect(s, box, 0)).length;
        const score = cuts * 100 + (sg.x1 === sg.x2 ? 30 : 0) - Math.min(len, 200) / 10 + Math.abs(t - 0.5) * 20;
        if (!best || score < best.score) best = { box, score };
      }
    }
    if (best) labels.push({ id: leg.id, box: best.box });
  }

  // Everything moves so the drawing starts at (0, 0) with a margin.
  const things = [...all, ...groups, ...labels.map((l) => l.box), ...captions, ...[...paths.values()].flat().map((p) => rect(p.x, p.y, 0, 0))];
  const dx = 8 - Math.min(...things.map((t) => t.l));
  const dy = 8 - Math.min(...things.map((t) => t.t));
  const move = (r) => ({ ...r, ...rect(r.x + dx, r.y + dy, r.w, r.h) });
  const out = {
    width: Math.max(...things.map((t) => t.r)) + dx + 8,
    height: Math.max(...things.map((t) => t.b)) + dy + 8,
    boxes: new Map([...boxes].map(([k, b]) => [k, move(b)])),
    groups: groups.map((g) => ({ ...move(g), kind: g.kind, label: g.label, labelBox: move(g.labelBox) })),
    captions: captions.map((c) => ({ ...move(c), key: c.key })),
    paths: new Map([...paths].map(([k, pts]) => [k, pts.map((p) => ({ x: p.x + dx, y: p.y + dy }))])),
    labels: new Map(labels.map((l) => [l.id, move(l.box)])),
    lanes: { req: lane.req + dy, res: lane.res + dy },
  };
  return out;
}

// Label pills: the font is 11px; numbers are small chips after the text.
function defaultLabelWidth(text, kind, chips = 0) {
  if (kind === 'group') return Math.ceil(text.length * 6.6) + 4;
  return (text ? Math.ceil(text.length * 6.4) + 14 : 6) + chips * 18;
}

// A leg on a lane: along the lane's line, leaving and entering on the facing sides
// where a box spans the lane, else turning up or down to it.
function laneCandidates(A, B, y0, xs) {
  const dir = B.cx > A.cx ? 1 : -1;
  const out = [];
  const spans = (R, y) => y > R.t + 10 && y < R.b - 10;
  const gapsNear = (R, side) => xs.filter((x) => (side > 0 ? x > R.r && x < R.r + GAP : x < R.l && x > R.l - GAP));
  for (const o of [0, -TRACK, TRACK, -2 * TRACK, 2 * TRACK, -3 * TRACK]) {
    const y = y0 + o;
    const starts = [];
    if (spans(A, y)) starts.push([{ x: dir > 0 ? A.r : A.l, y }]);
    else {
      const edge = y > A.b ? A.b : A.t;
      for (const px of [dir > 0 ? A.r - 18 : A.l + 18, A.cx, dir > 0 ? A.r - 34 : A.l + 34]) starts.push([{ x: px, y: edge }, { x: px, y }]);
      for (const k of [1, 0, -1]) for (const gx of gapsNear(A, dir)) starts.push([{ x: dir > 0 ? A.r : A.l, y: A.cy + k * 16 }, { x: gx, y: A.cy + k * 16 }, { x: gx, y }]);
    }
    const ends = [];
    if (spans(B, y)) ends.push([{ x: dir > 0 ? B.l : B.r, y }]);
    else {
      for (const gx of gapsNear(B, -dir)) for (const k of [0, 1, -1]) ends.push([{ x: gx, y }, { x: gx, y: B.cy + k * 16 }, { x: dir > 0 ? B.l : B.r, y: B.cy + k * 16 }]);
      const edge = y > B.b ? B.b : B.t;
      for (const px of [B.cx, dir > 0 ? B.l + 18 : B.r - 18]) ends.push([{ x: px, y }, { x: px, y: edge }]);
    }
    for (const s of starts) for (const e of ends) out.push([...s, ...e]);
  }
  // Two boxes side by side on the other row: straight across, near the lane.
  const lo = Math.max(A.t, B.t) + 12;
  const hi = Math.min(A.b, B.b) - 12;
  const near = [];
  for (let y = lo; y <= hi; y += TRACK / 2) near.push(y);
  near.sort((p, q) => Math.abs(p - y0) - Math.abs(q - y0));
  for (const y of near) out.push([{ x: dir > 0 ? A.r : A.l, y }, { x: dir > 0 ? B.l : B.r, y }]);
  return out;
}

// Any other leg: out of one side, along gaps and channels, into a side of the other.
// Two tiers: the simple shapes (up to three bends), and the long way round through a
// channel, tried only when no simple shape is clean.
function sideCandidates(A, B, xs, ys) {
  const ports = (R) => [
    ...[0, -1, 1].map((k) => ({ x: R.r, y: R.cy + k * 16, dx: 1, dy: 0 })),
    ...[0, -1, 1].map((k) => ({ x: R.l, y: R.cy + k * 16, dx: -1, dy: 0 })),
    ...[0, 1, -1].map((k) => ({ x: R.cx + k * 20, y: R.t, dx: 0, dy: -1 })),
    ...[0, 1, -1].map((k) => ({ x: R.cx + k * 20, y: R.b, dx: 0, dy: 1 })),
  ];
  const reach = 2 * (A.w + GAP);
  // Gaps a port can head into: on its outward side, not too far away.
  const outward = (p) => xs.filter((x) => Math.sign(x - p.x) === p.dx && Math.abs(x - p.x) < reach);
  const simple = [];
  const bent = [];
  for (const e of ports(A)) {
    for (const f of ports(B)) {
      const h1 = e.dy === 0;
      const h2 = f.dy === 0;
      if (h1 && h2) {
        if (e.y === f.y) simple.push([e, f]);
        for (const gx of xs) simple.push([e, { x: gx, y: e.y }, { x: gx, y: f.y }, f]);
        for (const g1 of outward(e)) for (const cy of ys) for (const g2 of outward(f)) bent.push([e, { x: g1, y: e.y }, { x: g1, y: cy }, { x: g2, y: cy }, { x: g2, y: f.y }, f]);
      } else if (!h1 && !h2) {
        if (e.x === f.x) simple.push([e, f]);
        for (const cy of ys) simple.push([e, { x: e.x, y: cy }, { x: f.x, y: cy }, f]);
      } else if (h1) {
        simple.push([e, { x: f.x, y: e.y }, f]);
        for (const gx of outward(e)) for (const cy of ys) bent.push([e, { x: gx, y: e.y }, { x: gx, y: cy }, { x: f.x, y: cy }, f]);
      } else {
        simple.push([e, { x: e.x, y: f.y }, f]);
        for (const cy of ys) for (const gx of outward(f)) bent.push([e, { x: e.x, y: cy }, { x: gx, y: cy }, { x: gx, y: f.y }, f]);
      }
    }
  }
  // Leaving a port must head out of its box, and arriving must head in.
  const heads = (pts) => {
    const s = simplify(pts);
    if (s.length < 2) return false;
    const e = pts[0];
    const f = pts.at(-1);
    const [a, b] = s;
    const [y, z] = s.slice(-2);
    return Math.sign(b.x - a.x) === e.dx && Math.sign(b.y - a.y) === e.dy && Math.sign(z.x - y.x) === -f.dx && Math.sign(z.y - y.y) === -f.dy;
  };
  return [simple.filter(heads), bent.filter(heads)];
}

// Drop repeated points and points in the middle of a straight run.
function simplify(pts) {
  const out = [];
  for (const p of pts) {
    const q = { x: p.x, y: p.y };
    const last = out.at(-1);
    if (last && Math.abs(last.x - q.x) < 0.01 && Math.abs(last.y - q.y) < 0.01) continue;
    const prev = out.at(-2);
    if (prev && last && ((Math.abs(prev.x - last.x) < 0.01 && Math.abs(last.x - q.x) < 0.01) || (Math.abs(prev.y - last.y) < 0.01 && Math.abs(last.y - q.y) < 0.01))) {
      // A straight run continues; a run that doubles back is kept as two segments.
      const back = (q.x - last.x) * (last.x - prev.x) + (q.y - last.y) * (last.y - prev.y) < 0;
      if (!back) out.pop();
    }
    out.push(q);
  }
  return out;
}

export function segments(pts) {
  const out = [];
  for (let i = 1; i < pts.length; i++) out.push({ x1: pts[i - 1].x, y1: pts[i - 1].y, x2: pts[i].x, y2: pts[i].y });
  return out;
}

const overlaps = (a, b, m = 0) => a.l < b.r + m && a.r > b.l - m && a.t < b.b + m && a.b > b.t - m;

// Does an axis-aligned segment pass through the rectangle grown by m?
function segHitsRect(s, R, m) {
  const l = Math.min(s.x1, s.x2);
  const r = Math.max(s.x1, s.x2);
  const t = Math.min(s.y1, s.y2);
  const b = Math.max(s.y1, s.y2);
  return l < R.r + m && r > R.l - m && t < R.b + m && b > R.t - m;
}

// No doubling back, no segment through a box: its own two boxes only at the ports,
// every other box (and the caption) kept CLEAR of.
function valid(segs, A, B, obstacles) {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.x1 !== s.x2 && s.y1 !== s.y2) return false;
    if (i && dot(segs[i - 1], s) < 0) return false;
    for (const o of obstacles) {
      if (o === A || o === B) {
        // The segment touching the port may only meet the box at its edge; the rest keep clear.
        const touches = (o === A && i === 0) || (o === B && i === segs.length - 1);
        if (touches ? segHitsRect(s, o, -0.5) : segHitsRect(s, o, CLEAR)) return false;
      } else if (segHitsRect(s, o, CLEAR)) return false;
    }
  }
  return true;
}
const dot = (a, b) => (a.x2 - a.x1) * (b.x2 - b.x1) + (a.y2 - a.y1) * (b.y2 - b.y1);

// Shorter, fewer bends, no crossings, and never along another leg. Length counts
// for little, so the clean shape wins over the short one.
function cost(segs, routed) {
  let c = segs.length * 40;
  for (const s of segs) c += (Math.abs(s.x2 - s.x1) + Math.abs(s.y2 - s.y1)) / 10;
  for (const r of routed) {
    for (const o of r.segs) {
      for (const s of segs) {
        if (crosses(s, o)) c += 400;
        const near = parallelNear(s, o);
        if (near !== null) c += near < 2 ? 100000 : near < TRACK - 1 ? 20000 : 0;
      }
    }
  }
  return c;
}

// Two perpendicular segments crossing in their interiors.
function crosses(a, b) {
  const ah = a.y1 === a.y2;
  const bh = b.y1 === b.y2;
  if (ah === bh) return false;
  const [h, v] = ah ? [a, b] : [b, a];
  const x = v.x1;
  const y = h.y1;
  const inside = (p, q, z) => z > Math.min(p, q) + 0.5 && z < Math.max(p, q) - 0.5;
  return inside(h.x1, h.x2, x) && inside(v.y1, v.y2, y);
}

// Two parallel segments whose ranges overlap: how far apart are they? null if not parallel or not overlapping.
function parallelNear(a, b) {
  const ah = a.y1 === a.y2;
  const bh = b.y1 === b.y2;
  if (ah !== bh) return null;
  const [p1, p2, q1, q2, d] = ah ? [a.x1, a.x2, b.x1, b.x2, Math.abs(a.y1 - b.y1)] : [a.y1, a.y2, b.y1, b.y2, Math.abs(a.x1 - b.x1)];
  const lo = Math.max(Math.min(p1, p2), Math.min(q1, q2));
  const hi = Math.min(Math.max(p1, p2), Math.max(q1, q2));
  return hi - lo > 1 ? d : null;
}

// What the build and the tests hold every layout to.
export function checkLayout(layout, graph) {
  const problems = [];
  const boxes = [...layout.boxes.values()];
  const legs = new Map(graph.legs.map((l) => [l.id, l]));
  const all = [...layout.paths].map(([id, pts]) => ({ id, segs: segments(pts) }));
  for (const { id, segs } of all) {
    const leg = legs.get(id);
    const A = layout.boxes.get(leg.a);
    const B = layout.boxes.get(leg.b);
    segs.forEach((s, i) => {
      if (s.x1 !== s.x2 && s.y1 !== s.y2) problems.push(`${id}: segment ${i + 1} is not horizontal or vertical`);
      for (const o of [...boxes, ...layout.captions]) {
        const end = o === A || o === B;
        const touches = (o === A && i === 0) || (o === B && i === segs.length - 1);
        if (end ? segHitsRect(s, o, touches ? -0.5 : 2) : segHitsRect(s, o, 2)) problems.push(`${id}: crosses ${o.key}`);
      }
    });
  }
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      for (const s of all[i].segs) for (const o of all[j].segs) {
        const near = parallelNear(s, o);
        if (near !== null && near < 4) problems.push(`${all[i].id} runs on top of ${all[j].id}`);
      }
    }
  }
  const labels = [...layout.labels];
  for (const [id, box] of labels) {
    for (const o of [...boxes, ...layout.captions]) if (overlaps(box, o, 1)) problems.push(`label of ${id} covers ${o.key}`);
    for (const [id2, box2] of labels) if (id < id2 && overlaps(box, box2, 1)) problems.push(`labels of ${id} and ${id2} overlap`);
  }
  for (const g of layout.groups) {
    for (const { id, segs } of all) if (segs.some((s) => segHitsRect(s, g.labelBox, 0))) problems.push(`${id} crosses the "${g.label}" label`);
  }
  for (const leg of graph.legs) {
    if (!layout.paths.has(leg.id)) problems.push(`${leg.id}: not drawn`);
    if ((leg.type === 'call' || leg.type === 'kvs') && !layout.labels.has(leg.id)) problems.push(`${leg.id}: no room for its label`);
  }
  return [...new Set(problems)];
}
