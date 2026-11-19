// Demo page for the network-call patterns. No framework, no build step.
// Patterns come from patterns.json (built by `npm run demo:index`): each one
// carries its demo.json fields plus its Mermaid sequence diagram. The strip
// picks one pattern for the stage. A request button calls the pattern path on
// this same distribution; the reply picks the demo.json "outcome" it matches,
// and both views replay the path it took.
import { parseSequence, resolvePath, pickOutcome, stepsNamed, matchPattern } from './sequence.js';
import { parseServerTiming, fromPerformance, readTiming } from './timing.js';
import { routes as flowRoutes, placements, flowGraph, layoutFlow } from './flow-layout.js';
import { highlight } from './code.js';

const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.esm.min.mjs';
// The replay's pace: one value (ms per step) sets every duration, the step interval,
// the token's travel, the trace drawing and the highlight fades, so they stay in sync.
// "step" moves only on Next. ?pace= in the URL wins over the remembered choice.
const PACES = { slow: 2500, normal: 1200, fast: 420, step: 1200 };
const PACE_KEY = 'cff-demo-pace';
const urlPace = new URLSearchParams(location.search).get('pace');
let pace = urlPace in PACES ? urlPace : localStorage.getItem(PACE_KEY) in PACES ? localStorage.getItem(PACE_KEY) : 'normal';
const stepMs = () => PACES[pace];
const travelMs = () => Math.round(stepMs() * 0.8);
const FONT = '"IBM Plex Sans", system-ui, sans-serif';
// Infrastructure headers that say nothing about the pattern. x-amz-cf-id and x-amz-cf-pop
// stay: they are CloudFront's request ID and edge location, what a bug report needs.
const NOISE = new Set(['x-amzn-trace-id', 'x-amzn-requestid']);
// Mermaid's colors, mapped to the page tokens. CSS variables resolve inside the
// inline SVG, so a theme switch needs no re-render.
const THEME_CSS = `
  .actor { fill: var(--canvas) !important; stroke: var(--line-strong) !important; }
  text.actor, text.actor > tspan { fill: var(--fg) !important; font-weight: 500; }
  .actor-line { stroke: var(--line) !important; }
  .messageLine0, .messageLine1 { stroke: var(--line-strong) !important; }
  .messageText { fill: var(--fg) !important; }
  marker path, #arrowhead path, #crosshead path, #filled-head path { fill: var(--line-strong) !important; stroke: var(--line-strong) !important; }
  marker circle { fill: var(--muted) !important; stroke: var(--muted) !important; }
  .sequenceNumber { fill: var(--canvas) !important; font-family: var(--mono); }
  .loopLine { stroke: var(--line-strong) !important; }
  .labelBox { fill: var(--surface-2) !important; stroke: var(--line-strong) !important; }
  .labelText, .labelText > tspan { fill: var(--muted) !important; font-weight: 600; }
  .loopText, .loopText > tspan, .sectionTitle, .sectionTitle > tspan { fill: var(--muted) !important; }
  .note { fill: var(--surface-2) !important; stroke: var(--line) !important; }
  .noteText, .noteText > tspan { fill: var(--fg) !important; }
  .step-el { transition: opacity var(--fade, 240ms) cubic-bezier(0.23, 1, 0.32, 1); }
  .skipped { opacity: 0.22; }
  .trace { fill: none; stroke: var(--trace) !important; stroke-width: 2.5px; stroke-linecap: round; pointer-events: none; }
  .trace.done { opacity: 0.8; stroke-width: 2px; }
  .trace-dot { fill: var(--trace) !important; stroke: none; pointer-events: none; }
  text.sequenceNumber.on-dot { fill: var(--action-ink) !important; font-weight: 600; }
  text.is-done, text.is-done > tspan { font-weight: 600 !important; }
  text.is-active, text.is-active > tspan { fill: var(--trace-ink) !important; font-weight: 600 !important; }
  rect.is-active { stroke: var(--trace) !important; stroke-width: 2px !important; }
  .branch-taken, .branch-taken > tspan { fill: var(--trace-ink) !important; font-weight: 600 !important; }
  .branch-skipped { opacity: 0.4; }
`;

const qs = (sel, root = document) => root.querySelector(sel);
const SVG_NS = 'http://www.w3.org/2000/svg';
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
};
// The SVG twin of el: attributes by setAttribute (null, undefined and false are left off).
const svgEl = (tag, attrs = {}, ...children) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  node.append(...children);
  return node;
};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const VIEW_KEY = 'cff-demo-view';
const VIEWS = { story: '.story-view', diagram: '.diagram', knowhow: '.knowhow' };
let currentView = localStorage.getItem(VIEW_KEY) in VIEWS ? localStorage.getItem(VIEW_KEY) : 'story';
const allViews = [];
// The function code panel beside the flow: shown unless turned off, remembered.
const CODE_KEY = 'cff-demo-code';
let codeShown = localStorage.getItem(CODE_KEY) !== 'off';
const REPO = 'https://github.com/aws-samples/sample-cloudfront-functions-network-calls-patterns/blob/main/';

// ---------- Mermaid ----------

let mermaidReady;
function loadMermaid() {
  mermaidReady ??= (async () => {
    await document.fonts.ready;
    const { default: mermaid } = await import(MERMAID_URL);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: FONT,
      fontSize: 13,
      themeVariables: { fontFamily: FONT, fontSize: '13px' },
      themeCSS: THEME_CSS,
      // Wrapped labels keep a seven-participant diagram near 1200 px; wider ones scroll.
      sequence: { useMaxWidth: false, mirrorActors: false, showSequenceNumbers: true, wrap: true, width: 160, actorMargin: 48, actorFontSize: 13, messageFontSize: 13, noteFontSize: 13, boxMargin: 8, messageMargin: 30 },
    });
    return mermaid;
  })();
  return mermaidReady;
}

// mermaid.render is not safe to run concurrently; chain the renders.
let renderQueue = Promise.resolve();
function renderDiagram(view) {
  view.rendered ??= (renderQueue = renderQueue.then(async () => {
    const box = qs('.diagram-scroll', view.root);
    try {
      const mermaid = await loadMermaid();
      const { svg } = await mermaid.render(`seq-${view.p.id}`, view.p.diagram);
      // Parsed as an inert document (no scripts run), then moved in as nodes.
      view.svg = qs('svg', new DOMParser().parseFromString(svg, 'text/html'));
      box.replaceChildren(view.svg);
      view.els = mapSteps(view.svg, view.model);
    } catch (e) {
      // No CDN or a diagram Mermaid rejects: show the source; requests still work.
      box.replaceChildren(el('pre', { className: 'fallback', textContent: view.p.diagram }));
      view.els = null;
      console.warn('diagram %s:', view.p.id, e);
    }
    paint(view);
  }));
  return view.rendered;
}

// Mermaid draws one messageLine per message in source order, its text just
// before it and its number just after; notes come as rect.note in order.
function mapSteps(svg, model) {
  const lines = [...svg.querySelectorAll('.messageLine0, .messageLine1')];
  const notes = [...svg.querySelectorAll('rect.note')];
  const messages = model.steps.filter((s) => s.kind === 'message').length;
  if (lines.length !== messages || notes.length !== model.steps.length - messages) return null;
  let m = 0;
  let n = 0;
  const steps = model.steps.map((s) => {
    if (s.kind === 'note') {
      const rect = notes[n++];
      return { path: null, parts: [rect.parentNode], marks: [rect, ...rect.parentNode.querySelectorAll('text')] };
    }
    const line = lines[m++];
    const parts = [line];
    for (let prev = line.previousElementSibling; prev?.classList.contains('messageText'); prev = prev.previousElementSibling) parts.unshift(prev);
    // With autonumber, a short marker line (the number's circle) and the number follow.
    for (let next = line.nextElementSibling; next && !next.matches('.messageText, .messageLine0, .messageLine1'); next = next.nextElementSibling) {
      if (next.matches('line:not([class]), .sequenceNumber')) parts.push(next);
      if (next.classList.contains('sequenceNumber')) break;
    }
    return { path: line, parts, marks: parts.filter((x) => x.classList.contains('messageText')) };
  });
  for (const s of steps) for (const part of s.parts) part.classList.add('step-el');
  // Branch titles ("[token present]") so the taken branch can be named on the diagram.
  const titles = [...svg.querySelectorAll('.loopText, .sectionTitle')].map((t) => ({ node: t, text: t.textContent.trim().replace(/^\[(.*)\]$/, '$1') }));
  return { steps, titles };
}

// ---------- The player: which steps ran, and how far the trace has got ----------

function paint(view, animateIndex = -1) {
  const { els, state } = view;
  const box = qs('.diagram', view.root);
  box.classList.toggle('traced', Boolean(state.taken));
  if (!els) return;
  view.svg.querySelectorAll('.trace, .trace-dot').forEach((t) => t.remove());
  els.steps.forEach((s, i) => {
    const skipped = state.taken ? !state.taken[i] : false;
    const pos = state.order.indexOf(i);
    const active = pos !== -1 && pos === state.cursor;
    const done = pos !== -1 && pos < state.cursor;
    for (const part of s.parts) part.classList.toggle('skipped', skipped);
    for (const mark of s.marks) {
      mark.classList.toggle('is-active', active);
      mark.classList.toggle('is-done', done);
    }
    const number = s.parts.find((x) => x.classList.contains('sequenceNumber'));
    number?.classList.toggle('on-dot', active || done);
    if ((active || done) && s.path) drawTrace(s.path, number, done, active && i === animateIndex);
  });
  for (const t of els.titles) {
    const branch = state.branches.find((b) => b.label && t.text && b.label === t.text);
    t.node.classList.toggle('branch-taken', Boolean(branch?.taken));
    t.node.classList.toggle('branch-skipped', Boolean(branch && !branch.taken));
  }
}

// A copy of the message line in --trace, drawn from sender to receiver, and a
// dot behind the step number (Mermaid's own number circle is a shared marker).
function drawTrace(path, number, done, animate) {
  const trace = document.createElementNS(SVG_NS, path.tagName);
  for (const a of ['x1', 'y1', 'x2', 'y2', 'd']) if (path.hasAttribute(a)) trace.setAttribute(a, path.getAttribute(a));
  trace.setAttribute('class', done ? 'trace done' : 'trace');
  path.after(trace);
  if (number) {
    const box = number.getBBox();
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', box.x + box.width / 2);
    dot.setAttribute('cy', box.y + box.height / 2);
    dot.setAttribute('r', 9);
    dot.setAttribute('class', 'trace-dot');
    number.before(dot);
  }
  if (!animate || reducedMotion.matches) return;
  const len = trace.getTotalLength();
  trace.animate(
    [{ strokeDasharray: `${len} ${len}`, strokeDashoffset: len }, { strokeDasharray: `${len} ${len}`, strokeDashoffset: 0 }],
    { duration: Math.round(stepMs() * 0.6), easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
  );
}

// Wide diagrams and station tracks scroll sideways: keep the active step in view. Never scrolls the page.
function follow(view) {
  const i = view.state.order[view.state.cursor];
  if (i === undefined) return;
  if (currentView === 'knowhow') return;
  const target = currentView === 'story' ? qs('.station.to', view.root) : view.els?.steps[i]?.marks[0];
  if (!target) return;
  const box = qs(currentView === 'story' ? '.track-wrap' : '.diagram-scroll', view.root);
  if (box.scrollWidth <= box.clientWidth) return;
  const r = target.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  const left = box.scrollLeft + r.left + r.width / 2 - b.left - box.clientWidth / 2;
  box.scrollTo({ left, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

// "Edge function → Cognito", "Edge function", or "Note over Edge function".
function who(view, s, name) {
  if (s.kind === 'note') return `${name === shortName ? 'Note over ' : ''}${s.over.map((id) => name(view, id)).join(', ')}`;
  return s.from === s.to ? name(view, s.from) : `${name(view, s.from)} → ${name(view, s.to)}`;
}

// demo.json actors: id -> { name, icon } or a plain name.
const actor = (view, id) => {
  const a = view.p.actors?.[id];
  return typeof a === 'string' ? { name: a } : a ?? {};
};
const actorName = (view, id) => actor(view, id).name ?? shortName(view, id);
const actorIcon = (view, id) => actor(view, id).icon ?? '';
const withIcon = (view, id) => `${actorIcon(view, id)} ${actorName(view, id)}`.trim();

const shortName = (view, id) => {
  const label = view.model.participants.find((x) => x.id === id)?.label ?? id;
  return label.replace(/\s*\(.*\)\s*$/, '').replace(/"/g, '');
};

function caption(view) {
  const { state } = view;
  const box = qs('.step', view.root);
  if (state.waiting) { box.textContent = 'Request sent; waiting for the edge…'; return; }
  if (state.cursor < 0 || !state.order.length) { box.textContent = state.note ?? 'Send a request to trace its path.'; return; }
  const s = view.model.steps[state.order[state.cursor]];
  const count = el('b', { textContent: `Step ${state.cursor + 1} of ${state.order.length}` });
  if (currentView !== 'diagram') { box.replaceChildren(count, ` · ${who(view, s, actorName)}`); return; }
  // Mermaid numbers messages only, so the diagram's own number is named too.
  const n = view.numbers[state.order[state.cursor]];
  box.replaceChildren(count, ` · ${n ? `#${n} ` : ''}${who(view, s, shortName)}: `, el('code', { textContent: s.text }));
}

// Back and Next work while it plays (they pause it); the third button pauses a
// replay, carries on from a paused one, or starts it over.
function controls(view) {
  const { state } = view;
  const playing = Boolean(state.timer);
  const last = state.order.length - 1;
  qs('.prev', view.root).disabled = state.cursor <= 0;
  qs('.next', view.root).disabled = state.cursor < 0 || state.cursor >= last;
  const replay = qs('.replay', view.root);
  const resume = !playing && pace !== 'step' && state.cursor >= 0 && state.cursor < last;
  replay.textContent = playing ? 'Pause' : resume ? 'Play' : 'Replay';
  replay.disabled = state.order.length < 2 || state.waiting;
}

function show(view, cursor, animate = false) {
  view.state.cursor = cursor;
  view.animateStep = animate ? cursor : -1;
  paint(view, animate ? view.state.order[cursor] : -1);
  paintStory(view);
  follow(view);
  caption(view);
  controls(view);
}

function stop(view) {
  clearInterval(view.state.timer);
  view.state.timer = null;
}

// Reduced motion jumps to the final state, whatever the pace.
function play(view, from = 0) {
  stop(view);
  const last = view.state.order.length - 1;
  if (reducedMotion.matches || !view.els) { show(view, last); return; }
  show(view, from, true);
  run(view);
}

// Advance at the pace's interval from where the replay is; "step" waits for Next.
function run(view) {
  stop(view);
  if (pace !== 'step' && view.state.cursor < view.state.order.length - 1) {
    view.state.timer = setInterval(() => {
      show(view, view.state.cursor + 1, true);
      if (view.state.cursor >= view.state.order.length - 1) { stop(view); controls(view); }
    }, stepMs());
  }
  controls(view);
}

function toggle(view) {
  const { state } = view;
  if (state.timer) { stop(view); controls(view); return; }
  if (pace !== 'step' && state.cursor >= 0 && state.cursor < state.order.length - 1 && !reducedMotion.matches) {
    show(view, state.cursor + 1, true);
    run(view);
    return;
  }
  play(view, 0);
}

function stepBy(view, delta) {
  const to = view.state.cursor + delta;
  if (to < 0 || to > view.state.order.length - 1 || view.state.cursor < 0) return;
  stop(view);
  show(view, to, delta > 0 && !reducedMotion.matches);
}

function setPace(next) {
  pace = next;
  localStorage.setItem(PACE_KEY, next);
  applyPace();
  for (const view of allViews) if (view.state.timer || next === 'step') run(view);
}

function applyPace() {
  // Highlight fades follow the pace too, within the 150 to 500ms a state change may take.
  document.documentElement.style.setProperty('--fade', `${Math.round(Math.min(500, Math.max(150, stepMs() * 0.25)))}ms`);
  for (const b of document.querySelectorAll('.pace button')) b.setAttribute('aria-pressed', String(b.dataset.pace === pace));
  for (const view of allViews) controls(view);
}

function freshState() {
  return { taken: null, order: [], cursor: -1, branches: [], timer: null, waiting: false, note: null };
}

// Apply an outcome: what ran, in what order, and how each branch title reads.
function trace(view, outcome) {
  const { model } = view;
  const { taken } = resolvePath(model, outcome ?? {});
  const decided = Boolean(outcome) || !model.blocks.some((b) => b.type === 'alt' || b.type === 'critical');
  const state = view.state;
  state.taken = decided ? taken : null;
  state.order = decided ? taken.flatMap((t, i) => (t ? [i] : [])) : [];
  state.branches = [];
  model.steps.forEach((s, i) => {
    for (const { block, branch } of s.scope) {
      const label = model.blocks[block].branches[branch].label;
      const entry = state.branches.find((b) => b.label === label) ?? state.branches[state.branches.push({ label, taken: false }) - 1];
      if (decided && taken[i]) entry.taken = true;
    }
  });
  if (!decided) state.branches = [];
}

// ---------- What happens: the default view, drawn on CloudFront's own path ----------
//
// Every pattern is placed on the same grid (demo/flow-layout.js): the viewer, then the
// edge location (TLS, WAF, the functions with KVS above them, the cache), then your
// account (called services, origins, what sits behind them, background workers in a row
// of their own). The request lane runs left to right through the viewer-request
// function, the reply lane comes back through the viewer-response function. Each
// connector is drawn once and never crosses a box; a network call is its own dashed,
// labelled style. Each diagram step rides some of the connectors, and a token rides along.

const FIXED = {
  tls: { icon: '🔒', name: 'TLS', role: 'HTTPS ends here' },
  waf: { icon: '🛡️', name: 'AWS WAF', role: 'No rule for this path' },
  cache: { icon: '🗄️', name: 'Cache', role: 'CloudFront cache' },
};
const STATION_W = 120;
const atOf = (view, id) => view.at.get(id);
const isFunction = (at) => at === 'viewer-request' || at === 'viewer-response';

function renderStory(view) {
  const { model, root } = view;
  view.routes = flowRoutes(view.p, model);
  view.graph = flowGraph(view.p, model, view.routes);
  view.legs = new Map(view.graph.legs.map((l) => [l.id, l]));
  qs('.gist', root).textContent = view.p.gist ?? '';
  const station = (key, { icon, name, role }, extra = '') => {
    const body = el('span', { className: 'body' }, el('span', { className: 'mark', ariaHidden: 'true', textContent: icon || '•' }), el('span', { className: 'name', textContent: name }));
    if (role) body.append(el('span', { className: 'role', textContent: role }));
    const node = el('div', { className: `station ${extra}`.trim() }, body);
    node.dataset.key = key;
    return node;
  };
  const person = (id) => {
    const name = actorName(view, id);
    const role = shortName(view, id);
    return { icon: actorIcon(view, id), name, role: role === name ? '' : role };
  };
  const first = (at) => model.participants.find((x) => atOf(view, x.id) === at)?.id;
  const viewer = first('viewer');
  const vr = first('viewer-request');
  const cache = first('cache');
  const waf = first('waf');
  const make = ({ key, place }) => {
    if (key === 'viewer') return station(key, viewer ? person(viewer) : { icon: '🧑‍💻', name: 'You' }, 'stage viewer');
    if (key === 'tls') return station(key, FIXED.tls, 'stage tls');
    if (key === 'waf') return waf ? station(key, person(waf), 'stage waf') : station(key, FIXED.waf, 'stage waf absent');
    if (key === 'vr') return station(key, vr ? person(vr) : { icon: '', name: 'No viewer-request function' }, `stage vr${vr ? '' : ' absent'}`);
    if (key === 'vresp') return station(key, person(first('viewer-response')), 'stage vresp');
    if (key === 'cache') return station(key, cache ? { ...person(cache), role: FIXED.cache.role } : FIXED.cache, 'stage cache');
    return station(key, person(key.slice(key.indexOf(':') + 1)), `side ${place}`);
  };
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'paths');
  svg.setAttribute('aria-hidden', 'true');
  const loop = qs('.loop', root);
  loop.replaceChildren(svg, ...view.graph.stations.map(make), el('span', { className: 'token', ariaHidden: 'true' }));
  view.layout = null;
  new ResizeObserver(() => paintStory(view, { resized: true })).observe(loop);
  paintStory(view);
}

// Label pills are 11px IBM Plex Sans; each step number is a chip after the text.
let measureCtx;
function labelWidth(text, kind, chips = 0) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = `600 ${kind === 'group' ? 12 : 11}px ${FONT}`;
  const t = text ? Math.ceil(measureCtx.measureText(text).width) : 0;
  return kind === 'group' ? t + 6 : (t ? t + 16 : 6) + chips * 19;
}

// Place the stations, groups and connectors. Every station is one size: the grid's
// column wide and as tall as the tallest one's text, so the layout only changes when
// the text does (fonts arriving, a cache verdict on two lines).
function layoutStory(view) {
  const loop = qs('.loop', view.root);
  const nodes = [...loop.querySelectorAll('.station')];
  for (const n of nodes) {
    n.style.width = `${STATION_W}px`;
    n.style.height = 'auto';
  }
  const h = Math.max(100, ...nodes.map((n) => Math.ceil(n.offsetHeight)));
  if (view.layout && view.layoutH === h) {
    for (const n of nodes) n.style.height = `${view.layout.boxes.get(n.dataset.key).h}px`;
    return;
  }
  const L = layoutFlow(view.graph, { w: STATION_W, h, labelWidth });
  view.layout = L;
  view.layoutH = h;
  loop.style.width = `${L.width}px`;
  loop.style.height = `${L.height}px`;
  const px = (n, b) => Object.assign(n.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
  for (const n of nodes) {
    const b = L.boxes.get(n.dataset.key);
    px(n, b);
    n.classList.toggle('tall', b.h > h + 1);
  }
  loop.querySelectorAll('.group, .ghost, .conn-label').forEach((n) => n.remove());
  const svg = qs('.paths', loop);
  for (const g of L.groups) {
    const box = el('div', { className: `group g-${g.kind}`, ariaHidden: 'true' }, el('span', { className: 'group-label', textContent: g.label }));
    px(box, g);
    Object.assign(box.firstChild.style, { left: `${g.labelBox.x - g.x}px`, top: `${g.labelBox.y - g.y}px` });
    svg.before(box);
  }
  for (const c of L.captions) {
    const n = el('p', { className: 'ghost', textContent: 'No viewer-response function' });
    px(n, c);
    svg.after(n);
  }
  svg.setAttribute('viewBox', `0 0 ${L.width} ${L.height}`);
  svg.setAttribute('width', L.width);
  svg.setAttribute('height', L.height);
  const id = view.p.id;
  const marker = (kind) => svgEl('marker', { id: `${id}-arrow-${kind}`, class: `arrow-${kind}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' }, svgEl('path', { d: 'M1 1 L9 5 L1 9' }));
  const conns = view.graph.legs.map((leg) => {
    const kind = leg.type === 'req' || leg.type === 'res' ? 'lane' : leg.type;
    const end = `url(#${id}-arrow-${kind})`;
    return svgEl('path', { class: `conn c-${kind}${leg.async ? ' async' : ''}`, 'data-leg': leg.id, d: pathOf(L.paths.get(leg.id)), 'marker-end': leg.arrowB && end, 'marker-start': leg.arrowA && end });
  });
  svg.replaceChildren(svgEl('defs', {}, ...['lane', 'call', 'kvs', 'direct', 'bg', 'trace'].map(marker)), svgEl('g', { class: 'conns' }, ...conns), svgEl('g', { class: 'trails' }));
  for (const [legId, box] of L.labels) {
    const leg = view.legs.get(legId);
    const kind = leg.type === 'req' || leg.type === 'res' ? 'lane' : leg.type;
    const n = el('span', { className: `conn-label c-${kind}`, title: leg.texts[0] ?? '' }, leg.label ? el('span', { className: 'conn-text', textContent: leg.label }) : '', el('span', { className: 'chips' }));
    n.dataset.leg = legId;
    Object.assign(n.style, { left: `${box.cx}px`, top: `${box.cy}px` });
    svg.after(n);
  }
}

const pathOf = (pts) => pts.map((pt, i) => `${i ? 'L' : 'M'}${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(' ');

// Before any request the timeline previews the first "ok" outcome's path.
function previewOrder(view) {
  const typical = view.p.outcomes?.find((o) => (o.tone ?? 'ok') === 'ok');
  const { taken } = resolvePath(view.model, typical ?? {});
  return view.model.steps.flatMap((s, i) => ((typical ? taken[i] : !s.scope.length) ? [i] : []));
}

// A reply the cache served never reached the origin: cut the origin out of the route.
function effective(view, route) {
  if (view.cache !== 'hit') return route;
  if (route.kind === 'forward') return { ...route, keys: route.keys.slice(0, route.keys.indexOf('cache') + 1) };
  if (route.kind === 'reply' && route.keys[0].startsWith('origin:')) return { ...route, keys: route.keys.slice(1) };
  return route;
}

function paintStory(view, { resized = false } = {}) {
  const { state, model, root } = view;
  const live = Boolean(state.taken) || state.waiting || state.order.length > 0;
  const order = live ? state.order : previewOrder(view);
  const timeline = qs('.timeline', root);
  const key = `${live}:${order.join(',')}`;
  if (!resized && timeline.dataset.key !== key) {
    timeline.dataset.key = key;
    timeline.classList.toggle('preview', !live);
    timeline.replaceChildren(...order.map((i, pos) => {
      const s = model.steps[i];
      const li = el('li', { className: s.kind === 'note' ? 'beat aside' : 'beat' },
        el('span', { className: 'no', textContent: String(pos + 1), ariaHidden: 'true' }),
        el('div', {}, el('p', { className: 'who', textContent: who(view, s, withIcon) }), el('p', { className: 'say', textContent: view.p.story?.[i] ?? s.text })));
      li.dataset.i = i;
      return li;
    }));
  }
  qs('.story-note', root).textContent = live ? (state.note ?? '') : 'A typical run. Send a request to see what really happens.';
  [...timeline.children].forEach((li, pos) => {
    li.classList.toggle('done', live && pos < state.cursor);
    li.classList.toggle('active', live && pos === state.cursor);
    li.classList.toggle('upcoming', live && state.cursor >= 0 && pos > state.cursor);
  });

  const loop = qs('.loop', root);
  if (!loop.offsetParent) return; // hidden: sizes mean nothing yet
  // Station texts that change (the cache's verdict, the origin's timing) come first, so the layout measures them.
  const t = view.timing;
  const cacheRole = qs('[data-key="cache"] .role', loop);
  // Server-Timing names the cache layer that answered; x-cache says Hit for all of them.
  const far = t?.cache === 'hit' && t.hitLayer && t.hitLayer !== 'EDGE' ? `Hit: from ${layerName(t.hitLayer)}` : null;
  if (cacheRole) cacheRole.textContent = far ?? { hit: 'Hit: answered from here', miss: 'Miss: went to the origin', edge: 'Not reached: the function answered', error: 'Error' }[view.cache] ?? FIXED.cache.role;
  layoutStory(view);
  const L = view.layout;

  const visible = order.map((i) => effective(view, view.routes[i]));
  const pos = live ? state.cursor : -1;
  const legsOf = (route) => view.graph.legsOf(route);
  // A leg's points in the direction a step rides it.
  const ride = (l) => (l.reverse ? [...L.paths.get(l.id)].reverse() : L.paths.get(l.id));
  // After a request, the steps so far ride the connectors in --trace. Before one, the
  // connectors alone show the typical run, through the step numbers on their labels.
  const trails = [];
  visible.forEach((route, p) => {
    if (!live || p > pos) return;
    const now = p === pos;
    const kind = now ? ' now' : '';
    const legs = legsOf(route);
    legs.forEach((l, k) => {
      const arrow = now && k === legs.length - 1 && `url(#${view.p.id}-arrow-trace)`;
      trails.push(svgEl('path', { class: `trail${kind}${model.steps[order[p]].async ? ' async' : ''}`, d: pathOf(ride(l)), 'marker-end': arrow }));
    });
  });
  qs('.trails', loop).replaceChildren(...trails);
  // The step that just started draws its trail in the token's time, leg after leg.
  if (!resized && live && view.animateStep === pos && !reducedMotion.matches) {
    const now = [...loop.querySelectorAll('.trail.now')];
    const lens = now.map((p) => p.getTotalLength());
    const total = lens.reduce((a, b) => a + b, 0) || 1;
    let done = 0;
    now.forEach((p, k) => {
      const len = lens[k];
      p.animate([{ strokeDasharray: `${len} ${len}`, strokeDashoffset: len }, { strokeDasharray: `${len} ${len}`, strokeDashoffset: 0 }],
        { duration: (travelMs() * len) / total, delay: (travelMs() * done) / total, fill: 'backwards', easing: 'linear' });
      done += len;
    });
  }
  // Connectors this run never rides are dimmed; each label lists the steps that ride it.
  const touched = new Set(visible.flatMap((r) => legsOf(r).map((l) => l.id)));
  for (const c of loop.querySelectorAll('.conn')) c.classList.toggle('unused', live && !touched.has(c.dataset.leg));
  for (const n of loop.querySelectorAll('.conn-label')) {
    const steps = visible.flatMap((r, p) => (legsOf(r).some((l) => l.id === n.dataset.leg) ? [p] : []));
    n.classList.toggle('unused', live && !steps.length);
    const shown = steps.length > 4 ? [...steps.slice(0, 3), null] : steps;
    qs('.chips', n).replaceChildren(...shown.map((p) => el('span', { className: `chip${p === pos ? ' now' : ''}${live && p !== null && p < pos ? ' done' : ''}`, textContent: p === null ? `+${steps.length - 3}` : String(p + 1) })));
  }

  // Stations: where the step starts and ends, what it passes, what this path never touches.
  const step = pos >= 0 ? model.steps[order[pos]] : null;
  const route = pos >= 0 ? visible[pos] : null;
  const moves = (r) => r.kind !== 'note' && r.kind !== 'self' && r.keys.length > 1;
  const stationKeys = new Set(visible.flatMap((r) => r.keys));
  for (const node of loop.querySelectorAll('.station')) {
    const k = node.dataset.key;
    const moving = Boolean(route) && moves(route);
    node.classList.toggle('from', moving && k === route.keys[0]);
    node.classList.toggle('to', Boolean(route) && (moving ? k === route.keys.at(-1) : route.keys.includes(k)));
    node.classList.toggle('via', moving && route.keys.slice(1, -1).includes(k));
    node.classList.toggle('unused', k !== 'waf' && !stationKeys.has(k));
  }
  // Once the replay has forwarded the request, the origin (or the cache, when the
  // diagram draws no origin) shows how long the origin took to send its first byte.
  const forward = live && t?.origin ? visible.slice(0, pos + 1).findLast((r) => r.kind === 'forward') : null;
  const timed = forward?.keys.at(-1);
  for (const node of loop.querySelectorAll('.station')) {
    let tag = node.querySelector('.timing-tag');
    if (node.dataset.key !== timed) { tag?.remove(); continue; }
    tag ??= node.appendChild(el('span', { className: 'timing-tag' }));
    tag.textContent = `${timed === 'cache' ? 'origin: ' : ''}first byte after ${ms(t.origin.firstByte)}`;
  }
  // The token starts on the first station's mark, rides the connectors, and ends on the last one's.
  const mark = (k) => {
    const b = L.boxes.get(k);
    return b && { x: b.cx, y: b.cy - 14 };
  };
  const pts = !route || !moves(route) ? [] : [mark(route.keys[0]), ...legsOf(route).flatMap(ride), mark(route.keys.at(-1))].filter(Boolean);
  if (!resized) moveToken(view, step, route, pts);
}

// The token: ✉️ a request or call, 💬 a reply, 📨 a fire-and-forget beacon.
// It rides the route's points; WAAPI offsets follow the length of each leg.
function moveToken(view, step, route, pts) {
  const token = qs('.token', view.root);
  const travels = Boolean(route) && pts.length > 1;
  token.classList.toggle('on', travels);
  if (!travels) { view.tokenStep = null; return; }
  const key = view.state.order[view.state.cursor];
  if (view.tokenStep === key) return;
  view.tokenStep = key;
  token.textContent = step.async ? '📨' : ['reply', 'call-reply', 'edge-answer'].includes(route.kind) ? '💬' : '✉️';
  // It carries its step number, the one in the list under the loop.
  token.dataset.n = String(view.state.cursor + 1);
  const at = (pt) => `translate(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px) translate(-50%, -125%)`;
  const end = at(pts.at(-1));
  if (reducedMotion.matches) { token.style.transform = end; return; }
  const legs = pts.slice(1).map((pt, i) => Math.hypot(pt.x - pts[i].x, pt.y - pts[i].y));
  const total = legs.reduce((a, b) => a + b, 0) || 1;
  let run = 0;
  const frames = pts.map((pt, i) => {
    if (i) run += legs[i - 1];
    return { transform: at(pt), offset: run / total };
  });
  token.animate(frames, { duration: travelMs(), easing: 'cubic-bezier(0.77, 0, 0.175, 1)' });
  token.style.transform = end;
}

// Space plays and pauses the pattern on stage (Next in step-by-step mode), the arrow
// keys step Back and Next. Keys meant for a field, a scroller or the pattern strip stay
// theirs, and Space on a focused button presses it, except on the pace control (Enter picks
// a pace there), so a presenter can choose "Step by step" and go on with Space.
addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable], .track-wrap, .diagram-scroll, .arch-wrap, .code-scroll, .strip')) return;
  const view = allViews.find((v) => !v.root.hidden);
  if (!view || view.state.cursor < 0) return;
  if (e.key === ' ') {
    if (e.target.closest('button, a, summary') && !e.target.closest('.pace')) return;
    e.preventDefault();
    if (pace === 'step') stepBy(view, 1);
    else toggle(view);
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    stepBy(view, e.key === 'ArrowRight' ? 1 : -1);
  }
});

function setView(next) {
  currentView = next;
  localStorage.setItem(VIEW_KEY, next);
  for (const view of allViews) applyView(view);
}

function applyView(view) {
  for (const b of view.root.querySelectorAll('.view-switch button')) b.setAttribute('aria-pressed', String(b.dataset.view === currentView));
  for (const [name, sel] of Object.entries(VIEWS)) {
    const box = qs(sel, view.root);
    box.classList.toggle('is-off', name !== currentView);
    box.toggleAttribute('aria-hidden', name !== currentView);
  }
  // The view that just came back measures its layout again.
  if (currentView === 'knowhow') paintArch(view);
  else if (currentView === 'diagram') paint(view);
  else paintStory(view);
  caption(view);
}

// ---------- The function code, beside the flow ----------
//
// patterns.json carries each pattern's function files as deployed (npm run demo:index
// reads the files pattern.ts deploys), so the panel shows exactly what CloudFront runs.

const HOOK_NAME = { 'viewer-request': 'viewer-request function', 'viewer-response': 'viewer-response function' };

function renderCode(view) {
  const { root, p } = view;
  const files = qs('.code-files', root);
  const copy = qs('.code .copy', root);
  const show = (c) => {
    for (const b of files.children) b.setAttribute('aria-pressed', String(b.dataset.file === c.file));
    // One block per line: CSS numbers them, and a wrapped line hangs under its own text.
    qs('.code-body', root).replaceChildren(...highlight(c.source).map((tokens) => el('span', { className: 'ln' }, ...tokens.map(([k, t]) => (k ? span(`t-${k}`, t) : t)))));
    qs('.code-note', root).textContent = `The ${HOOK_NAME[c.hook]}, deployed unchanged from ${c.path}.`;
    Object.assign(qs('.code-link', root), { href: REPO + c.path, title: `${c.path} in the repository` });
    qs('.code-scroll', root).setAttribute('aria-label', `${c.file}, the ${HOOK_NAME[c.hook]} of ${p.title}`);
    copy.onclick = () => copyText(copy, c.source);
    qs('.code-scroll', root).scrollTop = 0;
  };
  files.replaceChildren(...p.code.map((c) => {
    const b = el('button', { type: 'button', textContent: c.file, title: HOOK_NAME[c.hook] });
    b.dataset.file = c.file;
    b.addEventListener('click', () => show(c));
    return b;
  }));
  files.hidden = p.code.length < 2;
  if (p.code.length) show(p.code[0]);
  // The player's button, the drawer handle in the header and the tab it leaves behind
  // all drive one remembered state. The handle and the tab hand focus to each other.
  const panel = qs('.code-panel', root);
  panel.id = `${p.id}-code`;
  const tab = qs('.code-tab', root);
  const handle = qs('.code-collapse', root);
  for (const b of [qs('.code-toggle', root), tab, handle]) b.setAttribute('aria-controls', panel.id);
  qs('.code-toggle', root).addEventListener('click', () => setCodeShown(!codeShown, view));
  handle.addEventListener('click', () => setCodeShown(false, view, tab));
  tab.addEventListener('click', () => setCodeShown(true, view, handle));
  applyCode(view);
}

const codeBeside = matchMedia('(min-width: 90rem)');

function setCodeShown(next, from, focus) {
  if (next === codeShown) return;
  codeShown = next;
  localStorage.setItem(CODE_KEY, next ? 'on' : 'off');
  for (const view of allViews) applyCode(view, view === from, view === from ? focus : null);
}

// The drawer slides with the page's UI motion, not the replay pace: the panel slides
// toward its edge (right beside the flow, up when stacked) and fades, then the flow
// takes the room and the tab fades in. Opening runs it backwards.
function applyCode(view, animate = false, focus = null) {
  const has = view.p.code.length > 0;
  const { root } = view;
  const row = qs('.flow-row', root);
  const panel = qs('.code-panel', root);
  const tab = qs('.code-tab', root);
  qs('.code', root).hidden = !has;
  row.classList.toggle('code-none', !has);
  const toggle = qs('.code-toggle', root);
  toggle.hidden = !has;
  toggle.setAttribute('aria-pressed', String(codeShown));
  toggle.title = codeShown ? 'Hide the function code' : 'Show the function code beside the flow';
  const set = () => {
    row.classList.toggle('code-off', !codeShown);
    tab.setAttribute('aria-expanded', String(codeShown));
    qs('.code-collapse', root).setAttribute('aria-expanded', String(codeShown));
    focus?.focus({ preventScroll: true });
  };
  view.codeAnim?.cancel();
  view.codeAnim = null;
  if (!animate || !has || reducedMotion.matches) return set();
  const away = codeBeside.matches ? 'translateX(2rem)' : 'translateY(-0.5rem)';
  if (codeShown) {
    set();
    view.codeAnim = panel.animate([{ transform: away, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 240, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    return;
  }
  const anim = panel.animate([{ transform: 'none', opacity: 1 }, { transform: away, opacity: 0 }], { duration: 180, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'forwards' });
  view.codeAnim = anim;
  anim.finished.then(() => {
    set();
    anim.cancel();
    view.codeAnim = tab.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
  }, () => {});
}

// ---------- Know-how: where the code runs, and how the pattern is built ----------
//
// Both parts come from the same data as the other views: the diagram's routes,
// demo.json actors (service, access) and cachePolicy. Only the stage texts below
// are general, and they say what CloudFront does at that stage for every pattern.

const LIFE = [
  { key: 'tls', icon: '🔒', name: 'TLS', what: "The viewer's HTTPS connection ends at the edge location nearest to it." },
  { key: 'waf', icon: '🛡️', name: 'AWS WAF', what: "The distribution's web ACL runs here, before any function: it can block, challenge, count or label the request." },
  { key: 'vr', icon: '💂', name: 'Viewer-request function', what: 'Runs on every request, before the cache. It can change the request, answer it itself, choose the origin, read KVS, and make one network call: cf.fetch or cf.beacon to an origin of this distribution, with a fixed 1 s timeout.' },
  { key: 'cache', icon: '🗄️', name: 'Cache', what: 'A hit is answered here and never reaches the origin.' },
  { key: 'origin', icon: '🏠', name: 'Origin', what: "The service behind this behavior. CloudFront reaches it by origin id and proves it is CloudFront: origin access control signs the request, or a secret header or API key rides along." },
  { key: 'vresp', icon: '👋', name: 'Viewer-response function', what: 'Runs on the way back, cache hits included. It can change the response headers and make one network call. It does not run when the origin answers 400 or more.' },
];
const clip = (t, n = 64) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const tech = (view, id) => actor(view, id).service ?? shortName(view, id);

// What this pattern does at each stage, read off the diagram's routes.
function stageNotes(view) {
  const notes = { tls: [], waf: [], vr: [], cache: [], origin: [], vresp: [] };
  const add = (k, t) => { if (!notes[k].includes(t)) notes[k].push(t); };
  view.routes.forEach((r, i) => {
    const s = view.model.steps[i];
    if (s.kind !== 'message') return;
    const fn = r.keys[0] === 'vr' ? 'vr' : r.keys[0] === 'vresp' ? 'vresp' : null;
    if (r.kind === 'call' && fn) add(fn, `${atOf(view, s.to) === 'kvs' ? 'Reads KVS' : s.async ? 'Beacons to' : 'Calls'} ${atOf(view, s.to) === 'kvs' ? '' : `${shortName(view, s.to)}: `}${s.text}`.replace('KVS ', 'KVS: '));
    else if (r.kind === 'edge-answer') add(r.keys[0] === 'waf' ? 'waf' : 'vr', `Answers by itself: ${s.text}`);
    else if (r.kind === 'self' && (r.keys[0] === 'vr' || r.keys[0] === 'vresp')) add(r.keys[0], s.text);
    else if (r.kind === 'forward' && r.keys.at(-1).startsWith('origin:')) add('vr', `Forwards to ${shortName(view, s.to)}`);
    // What the response function hands back, when the diagram says more than "response"
    // (a caveat about when it does not run is already in the stage text).
    else if (r.kind === 'reply' && r.keys[0] === 'vresp' && !/^response$/i.test(s.text.trim()) && !/does not run/i.test(s.text)) add('vresp', `Hands back: ${s.text}`);
  });
  add('waf', view.p.waf ?? 'No rule matches this path, so the request passes (the web ACL allows by default).');
  const policy = view.p.cachePolicy ?? 'CachingDisabled';
  add('cache', policy === 'CachingDisabled' ? 'This behavior uses CachingDisabled: every request goes on to the origin.' : `This behavior uses ${policy}: repeat reads can be hits, and the viewer-request function still runs first.`);
  for (const x of view.model.participants) {
    if (atOf(view, x.id) !== 'origin') continue;
    const a = actor(view, x.id);
    add('origin', `${shortName(view, x.id)}: ${a.service ?? 'origin'}${a.access ? `; ${a.access}` : ''}`);
  }
  return notes;
}

function renderKnowhow(view) {
  const notes = stageNotes(view);
  const has = { tls: true, waf: Boolean(view.p.waf), vr: view.p.hooks.includes('viewer-request'), cache: true, origin: notes.origin.length > 0, vresp: view.p.hooks.includes('viewer-response') };
  qs('.life', view.root).replaceChildren(...LIFE.map((st, i) => {
    const li = el('li', { className: `life-stage${has[st.key] ? '' : ' off'}` },
      el('span', { className: 'life-n', textContent: String(i + 1), ariaHidden: 'true' }),
      el('div', {}, el('p', { className: 'life-name' }, el('span', { className: 'life-icon', ariaHidden: 'true', textContent: st.icon }), st.name),
        el('p', { className: 'life-what', textContent: st.what })));
    const here = notes[st.key];
    const none = st.key === 'vresp' && !has.vresp ? 'This pattern has none.' : st.key === 'vr' && !has.vr ? 'This pattern has none.' : '';
    if (here.length || none) li.lastChild.append(el('ul', { className: 'life-here' }, ...(here.length ? here : [none]).map((t) => el('li', { textContent: t }))));
    return li;
  }));
  renderArch(view);
}

// The architecture: the viewer, the distribution's behavior (functions, KVS, cache),
// then the pattern's own resources in the account, origins first, what sits behind them next.
function renderArch(view) {
  const arch = qs('.arch', view.root);
  const node = (key, icon, title, ...lines) => {
    const n = el('div', { className: 'node' }, el('p', { className: 'node-title' }, el('span', { ariaHidden: 'true', textContent: `${icon} ` }), title), ...lines.filter(Boolean).map((t) => el('p', { className: 'node-line', textContent: t })));
    n.dataset.n = key;
    return n;
  };
  const person = (id, extra) => {
    const a = actor(view, id);
    return node(`${extra}:${id}`, actorIcon(view, id) || '•', a.service ?? shortName(view, id), a.access ? `Access: ${a.access}` : '', `In the story: ${actorName(view, id)}`);
  };
  const ids = (at) => view.model.participants.filter((x) => atOf(view, x.id) === at).map((x) => x.id);
  const path = `/patterns/${view.p.id}/*`;
  const policy = view.p.cachePolicy ?? 'CachingDisabled';
  const kvsReads = [...new Set(view.model.steps.filter((st) => st.kind === 'message' && atOf(view, st.to) === 'kvs' && isFunction(atOf(view, st.from))).map((st) => st.text))];
  const edge = el('div', { className: 'zone z-edge' }, el('p', { className: 'zone-label', textContent: `CloudFront distribution · behavior ${path}` }),
    // Functions on the left, what the edge stores on the right: the cache, and KVS under it.
    el('div', { className: 'zone-grid' },
      el('div', { className: 'zone-col' },
        view.p.waf ? node('waf', '🛡️', 'AWS WAF web ACL (shared by the distribution)', view.p.waf) : null,
        view.p.hooks.includes('viewer-request') ? node('vr', '💂', 'CloudFront Function, viewer request', 'Runtime cloudfront-js-2.0', `In the story: ${actorName(view, ids('viewer-request')[0] ?? '')}`.replace(/: $/, '')) : null,
        view.p.hooks.includes('viewer-response') ? node('vresp', '👋', 'CloudFront Function, viewer response', 'Runtime cloudfront-js-2.0', ids('viewer-response').length ? `In the story: ${actorName(view, ids('viewer-response')[0])}` : '') : null),
      el('div', { className: 'zone-col' },
        node('cache', '🗄️', 'Cache', `Cache policy: ${policy}`, policy === 'CachingDisabled' ? 'Forwards every request to the origin' : 'Forwards misses to the origin'),
        ids('kvs').length ? node('kvs', actorIcon(view, ids('kvs')[0]) || '📒', 'KeyValueStore (shared)', `Access: ${actor(view, ids('kvs')[0]).access ?? 'read by the function'}`, kvsReads.length ? `Reads: ${kvsReads.join(', ')}` : '') : null)));
  const region = el('div', { className: 'zone z-region' }, el('p', { className: 'zone-label', textContent: 'Your AWS account: the pattern’s own resources' }),
    el('div', { className: 'zone-grid' },
      // Call-only services first: calls arrive from above, so nothing sits between them and the lane.
      el('div', { className: 'zone-col' }, ...ids('call').map((id) => person(id, 'call')), ...ids('origin').map((id) => person(id, 'origin'))),
      ids('backend').length ? el('div', { className: 'zone-col' }, ...ids('backend').map((id) => person(id, 'backend'))) : null));
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'arch-lines');
  svg.setAttribute('aria-hidden', 'true');
  arch.replaceChildren(svg, el('div', { className: 'zone z-viewer' }, node('viewer', actorIcon(view, ids('viewer')[0]) || '🧑‍💻', shortName(view, ids('viewer')[0] ?? 'V') || 'Viewer', 'Sends HTTPS requests')), edge, region);
  view.archEdges = archEdges(view);
  new ResizeObserver(() => paintArch(view)).observe(arch);
}

// Connections, each once: [from node, to node, label, dashed].
function archEdges(view) {
  const out = new Map();
  const put = (a, b, label, dashed, kind, full) => { if (a && b && a !== b && !out.has(`${a}>${b}`)) out.set(`${a}>${b}`, { a, b, label, dashed, kind, full }); };
  const keyOf = (id) => {
    const at = atOf(view, id);
    return { viewer: 'viewer', waf: 'waf', 'viewer-request': 'vr', 'viewer-response': 'vresp', cache: 'cache', kvs: 'kvs', origin: `origin:${id}`, call: `call:${id}`, backend: `backend:${id}` }[at];
  };
  // Short links between neighbours carry no label: the boxes say what they mean.
  if (view.p.waf) { put('viewer', 'waf', '', false, 'flow'); put('waf', 'vr', '', false, 'flow'); } else put('viewer', 'vr', '', false, 'flow');
  view.routes.forEach((r, i) => {
    const s = view.model.steps[i];
    if (s.kind !== 'message' || s.from === s.to || s.reply) return;
    // A KVS read stays inside the distribution: a direct link. A network call rides over the top.
    if (r.kind === 'call') put(keyOf(s.from), keyOf(s.to), atOf(view, s.to) === 'kvs' ? '' : s.text, s.async, atOf(view, s.to) === 'kvs' ? 'flow' : 'call', s.text);
    else if (r.kind === 'forward') {
      put('vr', 'cache', '', false, 'flow');
      if (r.keys.at(-1).startsWith('origin:')) put('cache', keyOf(s.to), '', false, 'flow');
    } else if (r.kind === 'direct') put(keyOf(s.from), keyOf(s.to), s.text, s.async, 'direct', s.text);
  });
  return [...out.values()];
}

const LANE = 28;

function paintArch(view) {
  const arch = qs('.arch', view.root);
  if (!arch || !arch.offsetParent || currentView !== 'knowhow') return;
  const svg = qs('.arch-lines', arch);
  arch.querySelectorAll('.edge-label').forEach((n) => n.remove());
  const nodes = [...arch.querySelectorAll('.node')];
  const nodeOf = (k) => arch.querySelector(`.node[data-n="${CSS.escape(k)}"]`);
  const local = (r, box) => ({ l: r.left - box.left, r: r.right - box.left, t: r.top - box.top, b: r.bottom - box.top, cx: r.left + r.width / 2 - box.left, cy: r.top + r.height / 2 - box.top, w: r.width });

  // How each link is drawn. Neighbours connect directly; a short link between two
  // stacked boxes goes straight; a network call rides a lane above the zones; anything
  // else rides a lane below. Classifying first lets the lanes get exactly the room they use.
  const edges = (view.archEdges ?? []).filter((e) => nodeOf(e.a) && nodeOf(e.b));
  let box = arch.getBoundingClientRect();
  for (const e of edges) {
    const a = local(nodeOf(e.a).getBoundingClientRect(), box);
    const b = local(nodeOf(e.b).getBoundingClientRect(), box);
    e.route = Math.abs(a.cx - b.cx) < Math.min(a.w, b.w) / 2 ? 'stacked'
      : e.kind === 'flow' && b.l >= a.r - 4 ? 'flow'
      : e.kind === 'call' && e.a !== 'vresp' ? 'over' : 'under';
  }
  const count = (route) => edges.filter((e) => e.route === route).length;
  arch.style.paddingTop = `${Math.max(1, count('over')) * LANE + 24}px`;
  arch.style.paddingBottom = `${Math.max(1, count('under')) * LANE + 24}px`;
  box = arch.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  const rects = nodes.map((n) => local(n.getBoundingClientRect(), box));
  // Does a vertical line at x from y1 to y2 pass through a box other than the two ends?
  const blocked = (x, y1, y2, ends) => rects.some((r, i) => !ends.includes(nodes[i]) && x > r.l && x < r.r && Math.max(y1, y2) > r.t && Math.min(y1, y2) < r.b);

  const drawn = [];
  let over = 0;
  let under = 0;
  for (const e of edges) {
    const ends = [nodeOf(e.a), nodeOf(e.b)];
    const a = local(ends[0].getBoundingClientRect(), box);
    const b = local(ends[1].getBoundingClientRect(), box);
    let d;
    let label;
    if (e.route === 'stacked') {
      const [y1, y2] = b.t > a.t ? [a.b, b.t] : [a.t, b.b];
      d = `M${a.cx} ${y1} V${y2}`;
      label = { side: true, x: a.cx, y: (y1 + y2) / 2 };
    } else if (e.route === 'flow') {
      const mx = (a.r + b.l) / 2;
      d = `M${a.r} ${a.cy} H${mx} V${b.cy} H${b.l}`;
      label = { x: mx, y: (a.cy + b.cy) / 2 };
    } else if (e.route === 'over') {
      const y = 18 + over++ * LANE;
      // Straight up from the top, unless a box sits above: then out of the side and up the gap.
      if (blocked(a.cx, a.t, y, ends)) {
        const gx = a.r + 6;
        d = `M${a.r} ${a.cy} H${gx} V${y} H${b.cx} V${b.t}`;
        label = { lane: [gx, b.cx], y };
      } else {
        d = `M${a.cx} ${a.t} V${y} H${b.cx} V${b.t}`;
        label = { lane: [a.cx, b.cx], y };
      }
    } else {
      // Through the gutters: out of the side facing the target, down the gap to this
      // link's lane, along it, then up the gap into the target's side. The offsets stay
      // inside the zones' padding so no line runs along a zone border.
      const i = under++;
      const y = box.height - 18 - i * LANE;
      const g = 4 + (i % 3) * 3;
      const right = b.cx > a.cx;
      const [x1, gx1] = right ? [a.r, a.r + g] : [a.l, a.l - g];
      const [x2, gx2] = right ? [b.l, b.l - g] : [b.r, b.r + g];
      d = `M${x1} ${a.cy} H${gx1} V${y} H${gx2} V${b.cy} H${x2}`;
      label = { lane: [gx1, gx2], y };
    }
    drawn.push({ e, d, label });
  }
  const arrow = svgEl('marker', { id: `arch-arrow-${view.p.id}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, svgEl('path', { d: 'M0 0 L10 5 L0 10 z', class: 'arch-arrow' }));
  svg.replaceChildren(svgEl('defs', {}, arrow), ...drawn.map(({ e, d }) => svgEl('path', { class: `arch-edge${e.dashed ? ' dashed' : ''}`, d, 'marker-end': `url(#arch-arrow-${view.p.id})` })));

  // Labels: a lane label sits on the widest stretch of its lane that no other link's
  // vertical crosses; a side label flips to the left when it would leave the drawing.
  const verticals = [...svg.querySelectorAll('.arch-edge')].flatMap((p) => {
    const out = [];
    let x = 0;
    let y = 0;
    for (const [, cmd, v] of p.getAttribute('d').matchAll(/([MHVL])\s*([-\d.]+(?:\s+[-\d.]+)?)/g)) {
      const n = v.split(/\s+/).map(Number);
      if (cmd === 'M') [x, y] = n;
      else if (cmd === 'H') x = n[0];
      else if (cmd === 'V') { out.push({ x, y1: Math.min(y, n[0]), y2: Math.max(y, n[0]) }); y = n[0]; }
    }
    return out;
  });
  for (const { e, label } of drawn) {
    if (!e.label) continue;
    const n = el('span', { className: 'edge-label', textContent: e.label, title: e.full ?? e.label });
    arch.append(n);
    const w = n.offsetWidth;
    const h = n.offsetHeight;
    let x = label.x;
    if (label.lane) {
      const [lo, hi] = [Math.min(...label.lane) + 4, Math.max(...label.lane) - 4];
      const cuts = verticals.filter((v) => v.x > lo && v.x < hi && v.y1 < label.y + h / 2 && v.y2 > label.y - h / 2).map((v) => v.x).sort((p, q) => p - q);
      const stops = [lo, ...cuts, hi];
      let best = [lo, hi];
      for (let i = 1; i < stops.length; i++) if (stops[i] - stops[i - 1] > best[1] - best[0]) best = [stops[i - 1], stops[i]];
      x = best[1] - best[0] >= w ? (best[0] + best[1]) / 2 : (lo + hi) / 2;
      n.style.left = `${Math.min(Math.max(x, w / 2 + 2), box.width - w / 2 - 2)}px`;
    } else if (label.side) {
      const left = label.x + 8 + w > box.width - 2;
      n.classList.add('side', ...(left ? ['left'] : []));
      n.style.left = `${left ? label.x - 8 : label.x + 8}px`;
    } else {
      n.style.left = `${x}px`;
    }
    n.style.top = `${label.y}px`;
  }
}

// ---------- Requests and responses ----------

function requestsOf(p) {
  const base = { method: p.method, path: p.tryPath, body: p.body, headers: {}, credentials: 'omit' };
  return (p.requests ?? [{ label: 'Try it' }]).map((r) => ({ ...base, ...r, headers: { ...base.headers, ...r.headers } }));
}

// A request with `bearerFrom` first gets a real token from that path ({ access_token, expires_in })
// and sends it as Authorization: Bearer. The page keeps it until a minute before it expires.
const tokens = new Map();
async function bearer(path) {
  const held = tokens.get(path);
  if (held && held.until > Date.now()) return held.token;
  const reply = await fetch(path, { cache: 'no-store', credentials: 'omit' });
  const json = reply.ok ? await reply.json().catch(() => null) : null;
  // A failed token call keeps its request ID, so the response panel can still show one.
  if (!json?.access_token) throw Object.assign(new Error(`${path} answered HTTP ${reply.status} without a token`), { rid: { ...readRid(reply.headers, null), from: `x-amz-cf-id of GET ${path}` } });
  tokens.set(path, { token: json.access_token, until: Date.now() + (Number(json.expires_in) - 60) * 1000 });
  return json.access_token;
}

// A body goes out as JSON. The Lambda Web Function origins behind OAC take an
// unsigned payload, so no body hash is needed.
async function buildRequest(r) {
  const headers = { ...r.headers };
  if (r.bearerFrom) headers.authorization = `Bearer ${await bearer(r.bearerFrom)}`;
  let body;
  if (r.body !== undefined) {
    body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    headers['content-type'] = 'application/json';
  }
  return { method: r.method, path: r.path, headers, body, credentials: r.credentials, bearerFrom: r.bearerFrom };
}

// Viewer-request functions show their work on the request, so most origins echo
// the headers they received back in the body. Collect x-* names found there.
function echoedHeaders(json) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (/^x-/i.test(k) && (typeof v !== 'object' || v === null)) out.push([k.toLowerCase(), String(v)]);
      else walk(v);
    }
  };
  walk(json);
  return out;
}

const line = (...parts) => [...parts, '\n'];
const span = (className, text) => el('span', { className, textContent: text });
const header = (k, v) => line(span('hn', `${k}: `), span(/^x-.*-error$/.test(k) ? 'err' : k.startsWith('x-') ? 'hv-x' : '', v));

function renderRequest(view, req) {
  const pre = el('pre', { className: 'wire' });
  pre.append(...line(span('start', `${req.method} ${req.path}`)));
  // A real token is long: show its start and end, copy it whole.
  for (const [k, v] of Object.entries(req.headers)) pre.append(...header(k, req.bearerFrom && k === 'authorization' && v.length > 60 ? `${v.slice(0, 32)}…${v.slice(-12)}` : v));
  if (req.bearerFrom) pre.append(...line(span('note', `The page got this token from GET ${req.bearerFrom} first.`)));
  pre.append(...line(span('note', req.credentials === 'omit' ? 'No cookies sent.' : 'Your cookies for this path are sent; cookies the reply sets are kept by the browser but hidden from this page.')));
  pre.append(span('note', 'The browser adds its own headers too (user-agent, accept, …).'));
  if (req.body !== undefined) pre.append('\n', span('gap', ''), JSON.stringify(JSON.parse(req.body), null, 2));
  qs('.request pre', view.root).replaceWith(pre);
  const copy = qs('.request .copy', view.root);
  copy.disabled = false;
  copy.textContent = 'Copy as curl';
  // Once the reply is in, the copy starts with its request ID: a new run of the curl gets a new one.
  copy.onclick = () => copyText(copy, `${view.rid?.id ? `# CloudFront request ID of the page's call: ${ridText(view.rid)}\n` : ''}${curl(req)}`);
}

function curl(req) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const url = new URL(req.path, location.href).href;
  const parts = ['curl -i', req.method === 'GET' ? '' : `-X ${req.method}`, q(url), ...Object.entries(req.headers).map(([k, v]) => `-H ${q(`${k}: ${v}`)}`)];
  if (req.body !== undefined) parts.push(`--data-raw ${q(req.body)}`);
  return parts.filter(Boolean).join(' \\\n  ');
}

const toneOf = (status) => (status < 300 ? 'ok' : status < 500 ? 'warn' : 'bad');

// CloudFront's request ID (RID) and edge location: x-amz-cf-id and x-amz-cf-pop are on every
// reply, function-generated ones included; Server-Timing's cdn-rid and cdn-pop are the fallback.
function readRid(headers, timing) {
  const id = headers.get('x-amz-cf-id');
  if (id) return { id, pop: headers.get('x-amz-cf-pop') ?? timing?.pop ?? null, from: 'x-amz-cf-id' };
  if (timing?.rid) return { id: timing.rid, pop: timing.pop ?? null, from: 'Server-Timing cdn-rid' };
  return { id: null, pop: headers.get('x-amz-cf-pop') ?? timing?.pop ?? null, from: null };
}
const ridText = (rid) => (rid?.id ? `${rid.id}${rid.pop ? ` (edge location ${rid.pop})` : ''}` : 'not available');

// The RID as a labelled field near the status line, one click to copy.
function renderRid(rid, why) {
  const node = el('div', { className: 'rid' }, el('span', { className: 'rid-label', textContent: 'CloudFront request ID' }));
  if (rid?.id) {
    const copy = el('button', { type: 'button', className: 'ghost rid-copy', textContent: 'Copy ID', title: 'Copy the request ID' });
    copy.addEventListener('click', () => copyText(copy, rid.id));
    node.append(el('code', { className: 'rid-value', textContent: rid.id }), copy);
  } else {
    node.append(el('span', { className: 'rid-none', textContent: `not available${why ? `: ${why}` : ''}` }));
  }
  const meta = [rid?.pop ? `edge location ${rid.pop}` : '', rid?.from ? `from ${rid.from}` : ''].filter(Boolean).join(' · ');
  if (meta) node.append(el('span', { className: 'rid-meta', textContent: meta }));
  return node;
}

// ---------- Recent requests: time, status and RID of the last few, on every pattern ----------

const HISTORY_KEY = 'cff-demo-history';
const HISTORY_MAX = 12;
let recent = [];
try { recent = JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? '[]'); } catch { /* none kept */ }

function record(view, entry) {
  recent = [{ at: new Date().toISOString(), pattern: `${view.p.number} ${view.p.id}`, ...entry }, ...recent].slice(0, HISTORY_MAX);
  try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(recent)); } catch { /* storage full or off */ }
  for (const v of allViews) renderHistory(v);
}

const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const historyLine = (h) => [h.at, h.pattern, `${h.label}: ${h.request}`, h.status ?? '-', h.rid ?? 'not available', h.pop ?? '-'].join('\t');

function renderHistory(view) {
  const box = qs('.history', view.root);
  box.hidden = !recent.length;
  qs('tbody', box).replaceChildren(...recent.map((h) => {
    const rid = h.rid ? el('button', { type: 'button', className: 'rid-chip', textContent: h.rid, title: 'Copy this request ID' }) : el('span', { className: 'rid-none', textContent: 'not available' });
    if (h.rid) rid.addEventListener('click', () => copyText(rid, h.rid));
    return el('tr', {},
      el('td', { className: 'h-time', textContent: timeOf(h.at), title: h.at }),
      el('td', { textContent: h.pattern }),
      el('td', { textContent: h.label, title: h.request }),
      el('td', { className: `h-status${h.tone ? ` status-${h.tone}` : ''}`, textContent: h.status ?? '—' }),
      el('td', {}, rid),
      el('td', { className: 'h-pop', textContent: h.pop ?? '—' }));
  }));
  const copy = qs('.history .copy', view.root);
  copy.onclick = () => copyText(copy, ['time\tpattern\trequest\tstatus\tx-amz-cf-id\tedge location', ...recent.map(historyLine)].join('\n'));
}

function renderResponse(view, res) {
  const pre = el('pre', { className: 'wire' });
  if (res.error) {
    pre.append(...line(span('status-bad start', 'No response')), span('note', `${res.error}. Check the connection and send it again.`));
  } else {
    pre.append(...line(span(`start status-${toneOf(res.status)}`, `HTTP ${res.status} ${res.statusText}`.trim()), span('note', ` · ${res.ms} ms`)));
    for (const [k, v] of res.shown) pre.append(...header(k, v));
    if (res.echoed.length) {
      pre.append(span('gap', ''), ...line(span('note', 'Echoed by the origin: what the function put on the request')));
      for (const [k, v] of res.echoed) pre.append(...header(k, v));
    }
    pre.append(span('gap', ''), res.json ? JSON.stringify(res.json, null, 2) : res.text || span('note', '(empty body)'));
  }
  const why = res.error && !res.rid ? 'no reply reached the page' : 'this reply has neither x-amz-cf-id nor a cdn-rid in Server-Timing';
  qs('.response .wire-wrap', view.root).replaceChildren(...(res.error ? [] : [renderTiming(view, res)]), renderRid(res.rid, why), pre);
  const copy = qs('.response .copy', view.root);
  copy.disabled = false;
  copy.onclick = () => copyText(copy, `CloudFront request ID: ${ridText(res.rid)}\n${pre.textContent}`);
}

// Where the time went, from CloudFront's Server-Timing header. The bar is the whole
// wait as the browser saw it: the edge's own work (the functions, any cf.fetch, the
// cache; CloudFront does not break cf.fetch out), the origin's DNS, connect and first
// byte, and the rest, between the browser and the edge. It is a breakdown, not a
// timeline. A reply a function generates carries no Server-Timing at all.
const ms = (n) => `${Math.round(n)}\u00a0ms`;
const LAYER = { EDGE: 'this edge location', REC: 'the regional edge cache' };
const layerName = (layer) => LAYER[layer] ?? layer;
function renderTiming(view, res) {
  const t = res.timing;
  const node = el('div', { className: 'timing' }, el('p', { className: 'timing-head' }, el('b', { textContent: 'Where the time went' }), t?.pop ? ` · edge location ${t.pop}` : ''));
  if (t?.edge === undefined) {
    const why = res.edgeAnswered
      ? 'The function answered this request itself, so there are no origin timings: CloudFront adds no Server-Timing header to a reply a function generates.'
      : t ? 'The Server-Timing header on this reply has no edge timing.' : 'This reply carries no Server-Timing header.';
    node.append(el('p', { className: 'timing-note', textContent: `${why} Your browser had the whole reply after ${ms(res.ms)}.` }));
    return node;
  }
  const o = t.origin;
  const upstream = o ? o.dns + o.connect + o.firstByte : 0;
  // The layer that answered from its cache, or that went to the origin.
  const far = t.cache === 'hit' ? t.hitLayer : o?.layer;
  const segs = [
    { cls: 'edge', ms: Math.max(0, t.edge - upstream), label: `At the edge: the functions, any cf.fetch, the cache${far && far !== 'EDGE' ? `, and the trip to ${layerName(far)}` : ''}` },
    ...(o ? [
      { cls: 'dns', ms: o.dns, label: o.dns ? 'Finding the origin (DNS)' : 'Finding the origin (DNS): already known' },
      { cls: 'connect', ms: o.connect, label: o.connect ? `Connecting to the origin from ${layerName(o.layer ?? 'EDGE')}` : 'Connecting to the origin: an open connection, reused' },
      { cls: 'origin', ms: o.firstByte, label: 'Waiting for the origin\'s first byte' },
    ] : []),
    { cls: 'net', ms: Math.max(0, res.ms - t.edge), label: 'Between your browser and the edge: the network and the download' },
  ];
  const cached = (view.p.cachePolicy ?? 'CachingDisabled') !== 'CachingDisabled';
  const verdict = {
    hit: !t.hitLayer || t.hitLayer === 'EDGE' ? 'served from this edge location\'s cache' : `served from ${layerName(t.hitLayer)}`,
    refresh: 'served from the cache once the origin confirmed it was still fresh',
    miss: cached ? 'a cache miss, so CloudFront asked the origin' : 'this path is not cached (CachingDisabled), so CloudFront asked the origin',
  }[t.cache];
  node.append(
    el('div', { className: 'tbar', ariaHidden: 'true' }, ...segs.filter((g) => g.ms > 0).map((g) => {
      const b = el('span', { className: `seg ${g.cls}` });
      b.style.flexGrow = String(g.ms);
      return b;
    })),
    el('ul', { className: 'tlegend' }, ...segs.map((g) => el('li', {}, el('i', { className: `sw ${g.cls}`, ariaHidden: 'true' }), el('b', { textContent: ms(g.ms) }), el('span', { textContent: g.label })))),
    el('p', { className: 'timing-note', textContent: `The edge sent the first byte after ${ms(t.edge)}${verdict ? `: ${verdict}` : ''}. Your browser had the whole reply after ${ms(res.ms)}.` }),
  );
  return node;
}

async function copyText(button, text) {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => { button.textContent = label; }, 1400);
}

async function send(view, r, button) {
  const { root, p } = view;
  leaveFrame(view);
  stop(view);
  view.state = freshState();
  view.state.waiting = true;
  view.cache = null;
  view.timing = null;
  view.rid = null;
  for (const b of root.querySelectorAll('.req')) b.disabled = true;
  button.setAttribute('aria-busy', 'true');
  const outcomeBox = qs('.outcome', root);
  outcomeBox.textContent = '';
  await renderDiagram(view);
  // The first step is the viewer's request: light it while the call is in flight,
  // unless it sits inside a branch (then which first step ran is only known from the reply).
  const litFirst = !view.model.steps[0].scope.length;
  if (litFirst) {
    view.state.order = [0];
    show(view, 0, true);
  }
  view.state.waiting = true;
  caption(view);

  let req;
  let res;
  try {
    req = await buildRequest(r);
  } catch (e) {
    req = { ...r, headers: { ...r.headers } };
    res = { error: `The page could not get a token (${e.message})`, rid: e.rid };
  }
  renderRequest(view, req);
  qs('.exchange', root).hidden = false;
  const t0 = performance.now();
  if (!res) try {
    const reply = await fetch(req.path, { method: req.method, headers: req.headers, body: req.body, cache: 'no-store', credentials: req.credentials });
    const text = await reply.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    const shown = [...reply.headers].filter(([k]) => (k.startsWith('x-') && !NOISE.has(k)) || k === 'content-type' || k === 'server-timing');
    // Server-Timing from the header, else from this fetch's resource timing entry (not an earlier one).
    const entry = performance.getEntriesByName(new URL(req.path, location.href).href, 'resource').findLast((e) => e.startTime >= t0);
    const timing = readTiming(reply.headers.has('server-timing') ? parseServerTiming(reply.headers.get('server-timing')) : fromPerformance(entry?.serverTiming));
    res = { status: reply.status, statusText: reply.statusText, ms: Math.round(performance.now() - t0), text, json, shown, echoed: echoedHeaders(json), timing, rid: readRid(reply.headers, timing), edgeAnswered: /FunctionGenerated/i.test(reply.headers.get('x-cache') ?? '') };
  } catch (e) {
    res = { error: `The browser could not complete the call (${e.message})` };
  }
  view.timing = res.timing ?? null;
  view.rid = res.rid ?? null;
  renderResponse(view, res);
  record(view, { label: r.label, request: `${req.method} ${req.path}`, status: res.status, tone: res.status ? toneOf(res.status) : 'bad', rid: res.rid?.id ?? null, pop: res.rid?.pop ?? null });
  view.state.waiting = false;
  for (const b of root.querySelectorAll('.req')) b.disabled = false;
  button.removeAttribute('aria-busy');

  if (res.error) {
    view.state = { ...freshState(), note: 'No response, so there is no path to trace.' };
    outcomeBox.dataset.tone = 'bad';
    outcomeBox.textContent = 'The request did not complete';
    show(view, -1);
    return;
  }
  const headers = new Map([...res.echoed, ...res.shown]);
  // Where CloudFront says the reply came from: the cache, the origin, or the function itself.
  const xcache = headers.get('x-cache') ?? '';
  view.cache = /^(Refresh)?Hit/i.test(xcache) ? 'hit' : /^Miss/i.test(xcache) ? 'miss' : /FunctionGenerated/i.test(xcache) ? 'edge' : /^Error/i.test(xcache) ? 'error' : null;
  const outcome = pickOutcome(p.outcomes, { status: res.status, headers, json: res.json });
  trace(view, outcome);
  outcomeBox.dataset.tone = outcome ? (outcome.tone ?? toneOf(res.status)) : 'none';
  outcomeBox.textContent = outcome?.label ?? `HTTP ${res.status}: this reply matches none of the paths this page knows for the pattern`;
  if (!view.state.order.length) {
    view.state.note = 'The reply does not tell which branch ran, so no path is highlighted.';
    show(view, -1);
    return;
  }
  // Step 1 is already drawn when it was lit in flight; carry on from step 2 then.
  play(view, litFirst && view.state.order[0] === 0 ? Math.min(1, view.state.order.length - 1) : 0);
}

// Wide content scrolls sideways inside its own box. An edge that hides content
// fades, and a button on that side scrolls most of a view, so overflow is never a secret.
function scrollHints(scroller) {
  const frame = el('div', { className: 'hframe' });
  scroller.replaceWith(frame);
  const button = (side) => {
    const b = el('button', { type: 'button', className: `hmore ${side}`, textContent: side === 'left' ? '‹' : '›', ariaLabel: side === 'left' ? 'Scroll left' : 'Scroll right', hidden: true });
    b.addEventListener('click', () => scroller.scrollBy({ left: (side === 'left' ? -0.8 : 0.8) * scroller.clientWidth, behavior: reducedMotion.matches ? 'auto' : 'smooth' }));
    return b;
  };
  const left = button('left');
  const right = button('right');
  frame.append(scroller, left, right);
  scroller.classList.add('hscroll');
  scroller.tabIndex = 0; // the arrow keys scroll it once it has focus
  const update = () => {
    const max = scroller.scrollWidth - scroller.clientWidth;
    const more = { left: scroller.scrollLeft > 2, right: scroller.scrollLeft < max - 2 };
    scroller.classList.toggle('more-left', more.left);
    scroller.classList.toggle('more-right', more.right);
    // A button that hides itself while focused hands focus on, never to the page.
    const focused = document.activeElement;
    left.hidden = !more.left;
    right.hidden = !more.right;
    if (focused === left && left.hidden) (right.hidden ? scroller : right).focus();
    if (focused === right && right.hidden) (left.hidden ? scroller : left).focus();
  };
  scroller.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(scroller);
  if (scroller.firstElementChild) new ResizeObserver(update).observe(scroller.firstElementChild);
  new MutationObserver(update).observe(scroller, { childList: true });
}

// ---------- A real page load in a frame (11's waiting room) ----------
//
// Some flows need a real browser page, not a fetch: 11's queue starts with AWS WAF's
// CAPTCHA, which a person solves. The page loads the path in a same-origin frame and reads
// every page the frame lands on to tell where the visitor is (demo.json frame.states). The
// frame is visible only while a person has to act in it; everything else, the admitted
// answer included, is shown in the page's own words, never as the raw page.

function leaveFrame(view) {
  const f = view.frame;
  if (!f) return;
  clearInterval(f.timer);
  f.iframe.remove();
  view.frame = null;
  f.onLeave?.();
}

// The first state whose "when" matches the frame's page, with its label filled in:
// {1}, {2} from the text's groups, {name} from the JSON body.
function frameState(r, doc) {
  const title = doc.title.trim();
  const text = (doc.body?.innerText ?? '').trim();
  let json = null;
  try { json = JSON.parse((doc.querySelector('pre') ?? doc.body)?.textContent ?? ''); } catch { /* not JSON */ }
  for (const st of r.frame.states) {
    const w = st.when ?? {};
    let groups = [];
    if (w.selector && !doc.querySelector(w.selector)) continue;
    if (w.title && !matchPattern(w.title, title)) continue;
    if (w.text) {
      const m = matchPattern(w.text, text);
      if (!m) continue;
      groups = m.slice(1);
    }
    if (w.json && !(json && Object.entries(w.json).every(([k, re]) => json[k] !== undefined && matchPattern(re, String(json[k]))))) continue;
    const label = st.label.replace(/\{(\d+)\}/g, (_, n) => groups[n - 1] ?? '').replace(/\{(\w+)\}/g, (_, k) => (json && json[k] !== undefined ? `"${json[k]}"` : ''));
    return { ...st, label };
  }
  return null;
}

// A page load's headers are hidden from scripts, x-amz-cf-id included. Server-Timing's cdn-rid
// reaches the frame's navigation entry, but only on a reply that went through the cache to
// the origin: CloudFront adds no Server-Timing to a reply a function or AWS WAF generates.
function frameLoad(iframe) {
  let nav = null;
  try { nav = iframe.contentWindow.performance.getEntriesByType('navigation')[0] ?? null; } catch { /* not same-origin */ }
  const t = readTiming(fromPerformance(nav?.serverTiming));
  return { status: nav?.responseStatus || null, rid: { id: t?.rid ?? null, pop: t?.pop ?? null, from: t?.rid ? 'Server-Timing cdn-rid' : null } };
}

function joinFrame(view, r, button) {
  const { root } = view;
  leaveFrame(view);
  stop(view);
  view.state = freshState();
  view.cache = null;
  view.timing = null;
  const outcomeBox = qs('.outcome', root);
  outcomeBox.dataset.tone = 'none';
  outcomeBox.textContent = 'Opening the page as your browser would…';
  show(view, -1);
  qs('.exchange', root).hidden = false;

  // Request: what the frame loads.
  const url = new URL(r.path, location.href).href;
  const req = el('pre', { className: 'wire' });
  req.append(...line(span('start', `GET ${r.path}`)), ...header('accept', 'text/html (a real page load)'),
    ...line(span('note', 'Loaded in a frame on this page with your cookies for this path, exactly as your browser loads a page.')));
  qs('.request pre', root).replaceWith(req);
  const copyReq = qs('.request .copy', root);
  copyReq.disabled = false;
  copyReq.textContent = 'Copy URL';
  copyReq.onclick = () => copyText(copyReq, url);

  // Response: the visitor's live state, in the page's own words.
  const track = el('ol', { className: 'milestones' }, ...r.frame.milestones.map((m) => el('li', { textContent: m })));
  const status = el('p', { className: 'queue-status', ariaLive: 'polite', textContent: 'Opening the page…' });
  const clock = el('p', { className: 'queue-clock' });
  // A fresh URL for the first load, so the browser cannot answer it from its cache
  // (an earlier visit's admitted page, say). The function's redirects use the bare path.
  const src = `${r.path}${r.path.includes('?') ? '&' : '?'}join=${Date.now()}`;
  const iframe = el('iframe', { title: `${view.p.title}: the check AWS WAF shows before the first ticket`, src });
  const box = el('div', { className: 'queue-frame', hidden: true },
    el('p', { className: 'queue-frame-note', textContent: 'AWS WAF shows this check once, before the first ticket. Solve it here; this page takes over after that.' }), iframe);
  const leave = el('button', { type: 'button', className: 'ghost', textContent: 'Leave the queue' });
  // Every page the frame lands on, with its request ID where the page can read one.
  const loads = el('ol', { className: 'frame-loads' });
  const loadsNote = el('p', { className: 'frame-loads-note', hidden: true, textContent: 'No ID shown: a page load hides its headers (x-amz-cf-id) from scripts, and CloudFront adds no Server-Timing to a page the function or AWS WAF generates. Only the admitted page, from the origin, carries its ID in Server-Timing.' });
  const loadsBox = el('div', { className: 'frame-log', hidden: true }, el('p', { className: 'frame-log-head', textContent: 'Page loads in the frame' }), loads, loadsNote);
  qs('.response .wire-wrap', root).replaceChildren(el('div', { className: 'queue' }, track, status, clock, box, leave, loadsBox));
  const copyRes = qs('.response .copy', root);
  copyRes.disabled = false;
  copyRes.onclick = () => copyText(copyRes, [status.textContent, clock.textContent, ...[...loads.children].map((li) => li.dataset.copy)].join('\n'));

  const f = { iframe, started: performance.now(), last: null, timer: null };
  view.frame = f;
  const tick = () => { clock.textContent = `${Math.round((performance.now() - f.started) / 1000)} s since you joined`; };
  f.timer = setInterval(tick, 1000);
  tick();
  // Leaving (the button, another request, another pattern) stops the page; once admitted it just ends.
  f.onLeave = () => {
    box.hidden = true;
    leave.hidden = true;
    if (f.done) return;
    status.textContent = 'You left the queue page. Your ticket cookie stays for two hours, so Join the queue again keeps your place.';
    outcomeBox.dataset.tone = 'none';
    outcomeBox.textContent = 'Left the queue';
  };
  leave.addEventListener('click', () => leaveFrame(view));
  // One row per state; a page that reloads into the same state updates its row.
  const logLoad = (st) => {
    const { status: code, rid } = frameLoad(iframe);
    const id = st?.id ?? 'unknown';
    let li = loads.lastElementChild;
    const fresh = li?.dataset.state !== id;
    if (fresh) {
      li = loads.appendChild(el('li'));
      li.dataset.state = id;
      li.dataset.count = '0';
    }
    li.dataset.count = String(Number(li.dataset.count) + 1);
    const times = Number(li.dataset.count) > 1 ? ` (${li.dataset.count} loads)` : '';
    const name = `${st?.id ?? 'a page this demo does not know'}${times}`;
    const value = rid.id ? el('button', { type: 'button', className: 'rid-chip', textContent: rid.id, title: 'Copy this request ID' }) : el('span', { className: 'rid-none', textContent: 'ID not readable' });
    if (rid.id) value.addEventListener('click', () => copyText(value, rid.id));
    li.replaceChildren(el('span', { className: 'fl-state', textContent: name }), code ? el('span', { className: 'fl-status', textContent: String(code) }) : '', value, rid.pop ? el('span', { className: 'rid-meta', textContent: rid.pop }) : '');
    li.dataset.copy = `${timeOf(new Date().toISOString())} ${name}${code ? ` HTTP ${code}` : ''}: ${ridText(rid)}`;
    loadsBox.hidden = false;
    loadsNote.hidden = !loads.querySelector('.rid-none');
    if (fresh) record(view, { label: `${r.label}: ${id}`, request: `GET ${r.path} (page load in a frame)`, status: code, tone: code ? toneOf(code) : null, rid: rid.id, pop: rid.pop });
  };

  iframe.addEventListener('load', () => {
    if (view.frame !== f) return;
    let doc = null;
    try { doc = iframe.contentDocument; } catch { /* not same-origin */ }
    if (!doc) return;
    const st = frameState(r, doc);
    logLoad(st);
    const wasHidden = box.hidden;
    box.hidden = !st?.show;
    // A person has to act in the frame (the CAPTCHA): bring it into view.
    if (st?.show && wasHidden) box.scrollIntoView({ block: 'center', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    if (!st) {
      status.textContent = `The frame shows a page this demo does not know${doc.title ? `: ${doc.title}` : ''}.`;
      return;
    }
    [...track.children].forEach((li, i) => {
      // A force argument must be a real boolean: undefined makes toggle() flip the class.
      li.classList.toggle('done', i < st.milestone || (Boolean(st.done) && i === st.milestone));
      li.classList.toggle('now', i === st.milestone && !st.done);
    });
    status.textContent = st.label;
    outcomeBox.dataset.tone = st.tone ?? 'ok';
    outcomeBox.textContent = st.label;
    // Replay up to where the visitor is now, only the steps this visit went through: a
    // visitor who already held a ticket gets no CAPTCHA and no ticket machine (the frame's
    // skipUnlessSeen), and the note above the step list says what was left out and why.
    // The replay carries on from the first step not shown yet.
    f.seen = f.seen ?? new Set();
    f.seen.add(st.id);
    if (f.last !== st.id) {
      const shown = new Set(view.state.order.slice(0, view.state.cursor + 1));
      const unseen = (r.frame.skipUnlessSeen ?? []).filter((e) => !e.seen.some((id) => f.seen.has(id)));
      const { taken } = resolvePath(view.model, st);
      const notes = unseen.filter((e) => e.note && e.steps.some((t) => stepsNamed(view.model, t).some((i) => taken[i]))).map((e) => e.note);
      trace(view, { ...st, drop: unseen.flatMap((e) => e.steps) });
      view.state.note = notes.join(' ') || null;
      const from = view.state.order.findIndex((i) => !shown.has(i));
      play(view, from === -1 ? Math.max(0, view.state.order.length - 1) : from);
      f.last = st.id;
    }
    if (st.done) {
      f.done = true;
      tick();
      leaveFrame(view);
    }
  });
  button.removeAttribute('aria-busy');
}

// ---------- Page ----------

async function loadPatterns() {
  const res = await fetch('patterns.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`patterns.json: HTTP ${res.status}`);
  return res.json();
}

function renderPattern(p) {
  const root = qs('#pattern-template').content.firstElementChild.cloneNode(true);
  root.id = p.id;
  root.dataset.tags = p.tags.join(' ');
  root.setAttribute('aria-labelledby', `${p.id}-title`);
  for (const sel of ['.track-wrap', '.diagram-scroll', '.arch-wrap']) scrollHints(qs(sel, root));
  const model = parseSequence(p.diagram);
  const view = { p, root, model, at: placements(p, model), state: freshState(), els: null };
  let count = 0;
  view.numbers = view.model.steps.map((step) => (step.kind === 'message' ? ++count : 0));

  qs('h2', root).id = `${p.id}-title`;
  qs('.num', root).textContent = p.number;
  qs('.title', root).textContent = p.title;
  qs('.hooks', root).textContent = p.hooks.join(' + ');
  for (const t of p.tags) qs('.tags', root).append(el('span', { textContent: t }));
  qs('.summary', root).textContent = p.summary;
  qs('.lesson', root).textContent = p.lesson;
  qs('.expect', root).replaceChildren(el('b', { textContent: 'Expect: ' }), p.expect);

  qs('.send', root).setAttribute('aria-label', `Requests for ${p.title}`);
  const reqs = requestsOf(p);
  reqs.forEach((r, i) => {
    const b = el('button', { type: 'button', className: i === 0 ? 'req primary' : 'req' }, el('span', { className: 'm', textContent: r.method }), r.label);
    b.title = `${r.method} ${r.path}`;
    b.addEventListener('click', () => (r.frame ? joinFrame(view, r, b) : send(view, r, b)));
    qs('.requests', root).append(b);
  });
  // A tab can only send a plain GET: link the first request that needs no headers.
  const open = qs('.open', root);
  const plain = reqs.find((r) => r.method === 'GET' && !r.frame && !r.bearerFrom && Object.keys(r.headers).length === 0);
  if (plain) Object.assign(open, { href: plain.path, title: `${plain.label}, in a new tab` });
  else open.remove();

  const names = view.model.participants.map((x) => shortName(view, x.id));
  qs('.diagram-scroll', root).setAttribute('aria-label', `Sequence diagram for ${p.title}: ${names.join(', ')}; ${view.model.steps.length} steps.`);
  qs('.track-wrap', root).setAttribute('aria-label', `What happens in ${p.title}, drawn on CloudFront's path`);
  qs('.arch-wrap', root).setAttribute('aria-label', `How ${p.title} is built`);
  qs('.prev', root).addEventListener('click', () => stepBy(view, -1));
  qs('.next', root).addEventListener('click', () => stepBy(view, 1));
  qs('.replay', root).addEventListener('click', () => toggle(view));
  for (const b of root.querySelectorAll('.pace button')) {
    b.setAttribute('aria-pressed', String(b.dataset.pace === pace));
    b.addEventListener('click', () => setPace(b.dataset.pace));
  }
  for (const b of root.querySelectorAll('.view-switch button')) b.addEventListener('click', () => setView(b.dataset.view));
  renderStory(view);
  renderKnowhow(view);
  renderCode(view);
  renderHistory(view);
  allViews.push(view);
  applyView(view);
  return view;
}

// Scroll the pattern strip, never the page, until the card is fully in view.
function revealCard(card, behavior) {
  const wrap = qs('.strip');
  const item = card.parentElement;
  const left = item.offsetLeft;
  const right = left + item.offsetWidth;
  if (left < wrap.scrollLeft) wrap.scrollTo({ left, behavior });
  else if (right > wrap.scrollLeft + wrap.clientWidth) wrap.scrollTo({ left: right - wrap.clientWidth, behavior });
}

// The tag that colors a pattern's card: its first tag other than the one most share.
const family = (p) => p.tags.find((t) => t !== 'ai-gateway') ?? p.tags[0] ?? '';

function render(patterns) {
  const stage = qs('#stage');
  qs('#loading').remove();
  if (!patterns.length) {
    stage.append(el('p', { className: 'muted', textContent: 'No patterns yet.' }));
    return;
  }
  const views = patterns.map(renderPattern);
  applyPace();
  views.forEach((v, i) => {
    v.root.hidden = true;
    v.root.dataset.family = family(v.p);
    stage.append(v.root);
    const card = el('a', { className: 'card', href: `#${v.p.id}`, title: v.p.title },
      el('span', { className: 'n', textContent: v.p.number }),
      el('span', { className: 't', textContent: v.p.title }));
    card.dataset.family = family(v.p);
    const item = qs('#strip').appendChild(el('li', {}, card));
    item.dataset.tags = v.p.tags.join(' ');
    v.card = card;
    for (const [cls, other, arrow] of [['.prev-pattern', views[i - 1], '← '], ['.next-pattern', views[i + 1], ' →']]) {
      if (!other) continue;
      const link = qs(cls, v.root);
      link.href = `#${other.p.id}`;
      link.textContent = arrow === '← ' ? `${arrow}${other.p.number} ${other.p.title}` : `${other.p.number} ${other.p.title}${arrow}`;
      link.hidden = false;
    }
  });
  renderTagFilter(patterns);

  // One pattern on stage at a time; the URL hash names it.
  let shown = null;
  const select = (id, fromNavigation) => {
    const view = views.find((v) => v.p.id === id) ?? views[0];
    if (view === shown) return;
    if (shown) { leaveFrame(shown); stop(shown); shown.root.hidden = true; shown.card.removeAttribute('aria-current'); }
    shown = view;
    view.root.hidden = false;
    view.card.setAttribute('aria-current', 'true');
    revealCard(view.card, fromNavigation && !reducedMotion.matches ? 'smooth' : 'auto');
    renderDiagram(view);
    if (fromNavigation && qs('#stage').getBoundingClientRect().top < 0) scrollTo({ top: 0 });
  };
  addEventListener('hashchange', () => select(location.hash.slice(1), true));
  select(location.hash.slice(1), false);
  scrollTo({ top: 0 });
}

// A select with every tag in patterns.json: a tag hides the strip entries that
// do not carry it; the pattern on stage stays.
function renderTagFilter(patterns) {
  const pick = qs('#tag-filter');
  const tags = [...new Set(patterns.flatMap((p) => p.tags))].sort();
  if (!tags.length) return;
  pick.append(el('option', { value: '', textContent: 'All tags' }), ...tags.map((t) => el('option', { value: t, textContent: t })));
  pick.addEventListener('change', () => {
    for (const node of qs('#strip').children) node.hidden = pick.value !== '' && !node.dataset.tags.split(' ').includes(pick.value);
  });
  pick.hidden = false;
}

// Sticky things below the top bar need its height.
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty('--bar-h', `${Math.ceil(entry.target.getBoundingClientRect().height)}px`);
}).observe(qs('.topbar'));

loadPatterns()
  .then(render)
  .catch((e) => {
    console.error(e);
    const note = qs('#loading') ?? qs('#stage').appendChild(el('p', { className: 'muted' }));
    note.textContent = `Could not show the patterns (${e.message}).`;
  });
