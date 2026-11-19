// Reads a Mermaid sequenceDiagram into steps and works out which steps a real
// response took. Shared by the page (app.js) and by scripts/build-demo-index.mjs,
// which checks every pattern's demo.json "outcomes" against its diagram.
//
// A step is one message or note, in source order. Each step remembers the
// blocks (alt, opt, par, ...) it sits in and which branch of each. An outcome
// names the branches it took by label prefix; a bare `else` is called "otherwise".

// from, arrow (-->> ->> --x -x --) -) --> ->), to, text.
const MESSAGE_RE = /^([^\s:+-][^:]*?)\s*(-->>|->>|--x|-x|--\)|-\)|-->|->)\s*[+-]?\s*([^:]+?)\s*:\s*(.*)$/;
const NOTE_RE = /^note\s+(over|left of|right of)\s+([^:]+?)\s*:\s*(.*)$/i;
const PARTICIPANT_RE = /^(participant|actor)\s+(\S+)(?:\s+as\s+(.+))?$/i;
// Block keywords: the first opens a block, the rest add a branch to the open one.
const OPENERS = new Set(['alt', 'opt', 'par', 'loop', 'critical', 'break', 'rect']);
const BRANCHERS = { else: 'alt', and: 'par', option: 'critical' };
// Blocks where exactly one branch runs; every other block runs all its branches.
const CHOICE = new Set(['alt', 'critical']);
// Blocks that run only when an outcome names them.
const OPTIONAL = new Set(['opt', 'break']);

export const OTHERWISE = 'otherwise';

export function parseSequence(source) {
  const participants = [];
  const blocks = [];
  const steps = [];
  const stack = [];
  const seen = new Set();
  const addParticipant = (id, label = id) => {
    if (seen.has(id)) return;
    seen.add(id);
    participants.push({ id, label: label.replace(/^"(.*)"$/, '$1') });
  };
  const scope = () => stack.map((b) => ({ block: b.index, branch: b.branches.length - 1 }));

  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('%%') || /^(sequenceDiagram|autonumber)\b/.test(line)) continue;
    const [word] = line.split(/\s+/, 1);
    const rest = line.slice(word.length).trim();
    let m;
    if ((m = PARTICIPANT_RE.exec(line))) {
      addParticipant(m[2], m[3] ?? m[2]);
    } else if (OPENERS.has(word)) {
      const block = { index: blocks.length, type: word, branches: [{ label: rest }], depth: stack.length };
      blocks.push(block);
      stack.push(block);
    } else if (word in BRANCHERS) {
      const open = stack.at(-1);
      if (!open || open.type !== BRANCHERS[word]) throw new Error(`"${line}" outside a ${BRANCHERS[word]} block`);
      open.branches.push({ label: rest || OTHERWISE });
    } else if (word === 'end') {
      if (!stack.pop()) throw new Error('"end" without an open block');
    } else if ((m = NOTE_RE.exec(line))) {
      steps.push({ kind: 'note', over: m[2].split(',').map((s) => s.trim()), text: m[3], scope: scope() });
    } else if ((m = MESSAGE_RE.exec(line))) {
      const [, from, arrow, to, raw] = m;
      // Mermaid's entity codes, as it renders them: #35; is a literal # (a bare # cuts the label).
      const text = raw.replace(/#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
      addParticipant(from.trim());
      addParticipant(to.trim());
      steps.push({ kind: 'message', from: from.trim(), to: to.trim(), arrow, text, async: arrow.includes(')'), reply: arrow.startsWith('--'), scope: scope() });
    }
  }
  if (stack.length) throw new Error(`${stack.length} block(s) not closed with "end"`);
  return { participants, blocks, steps };
}

const norm = (s) => s.trim().toLowerCase();

// Which branch of which block each "take" label names. Unknown or ambiguous labels are errors.
function choices(model, take) {
  const chosen = new Map();
  const errors = [];
  for (const label of take) {
    const hits = [];
    for (const b of model.blocks) b.branches.forEach((br, i) => { if (norm(br.label).startsWith(norm(label))) hits.push([b.index, i]); });
    if (hits.length !== 1) { errors.push(`"${label}" matches ${hits.length} branches`); continue; }
    const [block, branch] = hits[0];
    if (chosen.has(block) && chosen.get(block) !== branch) errors.push(`"${label}" picks a second branch of the same block`);
    chosen.set(block, branch);
  }
  return { chosen, errors };
}

// The steps a skip or drop text names: the exact text if one step has it (a short step
// can be the prefix of a longer one), else every step it starts.
export function stepsNamed(model, text) {
  const exact = model.steps.flatMap((step, i) => (norm(step.text) === norm(text) ? [i] : []));
  return exact.length === 1 ? exact : model.steps.flatMap((step, i) => (norm(step.text).startsWith(norm(text)) ? [i] : []));
}

// Which steps an outcome took. Returns, for each step, true (taken) or false
// (not taken), plus the choice blocks the outcome reached but did not decide.
// An outcome is { take, stopAfter, lastStep, skip, drop }:
// - take: branch labels (by prefix) the reply went through
// - stopAfter: a branch whose last step ends the exchange (an early reply inside
//   an opt, say); nothing after it runs
// - lastStep: a message number as Mermaid's autonumber shows it; the steps after
//   it did not run (background work that only happens sometimes)
// - skip: steps inside a taken branch that still did not run (a note about GET and
//   HEAD on a POST's path, say), named by their exact text or a text prefix; each
//   must name one step on the path
// - drop: steps that run only on some visits (a frame's skipUnlessSeen), named the
//   same way; a step not on this path is fine, and only a text's steps on the path
//   count, so it may share its text with a step in a branch not taken
export function resolvePath(model, { take = [], stopAfter, lastStep, skip = [], drop = [] } = {}) {
  const { chosen, errors } = choices(model, stopAfter ? [...take, stopAfter] : take);
  const runs = (block, branch) => {
    const b = model.blocks[block];
    if (CHOICE.has(b.type)) return chosen.get(block) === branch;
    if (OPTIONAL.has(b.type)) return chosen.get(block) === branch;
    return true;
  };
  const taken = model.steps.map((s) => s.scope.every(({ block, branch }) => runs(block, branch)));
  let last = taken.length - 1;
  if (stopAfter && !errors.length) {
    const [block, branch] = [...chosen].find(([b, i]) => norm(model.blocks[b].branches[i].label).startsWith(norm(stopAfter)));
    last = model.steps.findLastIndex((s) => s.scope.some((e) => e.block === block && e.branch === branch));
    for (let i = last + 1; i < taken.length; i++) taken[i] = false;
  }
  if (lastStep !== undefined) {
    let n = 0;
    const cut = model.steps.findIndex((step) => step.kind === 'message' && ++n === lastStep);
    if (cut === -1) errors.push(`lastStep ${lastStep}: the diagram has ${n} messages`);
    else {
      for (let i = cut + 1; i < taken.length; i++) taken[i] = false;
      last = Math.min(last, cut);
    }
  }
  for (const prefix of skip) {
    const hits = stepsNamed(model, prefix);
    if (hits.length !== 1) errors.push(`skip "${prefix}" matches ${hits.length} steps`);
    else if (!taken[hits[0]]) errors.push(`skip "${prefix}" names a step that is not on this outcome's path`);
    else taken[hits[0]] = false;
  }
  const dropped = [];
  for (const prefix of drop) {
    const all = stepsNamed(model, prefix);
    const hits = all.filter((i) => taken[i]);
    if (!all.length) errors.push(`drop "${prefix}" matches no step`);
    else if (hits.length > 1) errors.push(`drop "${prefix}" matches ${hits.length} steps on this path`);
    else if (hits.length) dropped.push(hits[0]);
  }
  for (const i of dropped) taken[i] = false;
  const undecided = new Set();
  model.steps.slice(0, last + 1).forEach((s) => {
    for (const [i, { block }] of s.scope.entries()) {
      // Only blocks the path actually reaches: every enclosing branch runs.
      if (!s.scope.slice(0, i).every((e) => runs(e.block, e.branch))) break;
      // A one-branch alt reads like an opt: not naming it means it did not run.
      const b = model.blocks[block];
      if (CHOICE.has(b.type) && b.branches.length > 1 && !chosen.has(block)) undecided.add(block);
    }
  });
  return { taken, errors, undecided: [...undecided].map((i) => model.blocks[i].branches[0].label) };
}

// demo.json "when" patterns read like regexes but run on this small matcher, never
// through RegExp, so no pattern from data is compiled. It knows literal text, . (any
// character), \d \w \s, [a-z0-9-] and [^…] sets, (a|b) groups that capture, \1 backreferences,
// the counts + * ? {n} {n,m}, and ^ $ anchors; anything else is an error. Matching ignores
// case, and each piece takes all it can and never gives it back (no backtracking): enough
// for "^(\d+)/\1$" or "Position about (\d+)", and linear, so no pattern can hang the page.
const CLASSES = { d: [['0', '9']], w: [['a', 'z'], ['A', 'Z'], ['0', '9'], ['_', '_']], s: [[' ', ' '], ['\t', '\r']] };
const SPECIAL = '\\^$.|?*+()[]{}/-';

function parsePattern(src) {
  let i = 0;
  let groups = 0;
  const fail = (why) => { throw new Error(`pattern "${src}": ${why} at ${i}`); };
  const escape = () => {
    const c = src[i++];
    if (c === undefined) fail('a lone \\');
    if (c in CLASSES) return { kind: 'set', ranges: CLASSES[c] };
    if (c >= '1' && c <= '9') return { kind: 'ref', n: Number(c) };
    if (!SPECIAL.includes(c)) fail(`unknown escape \\${c}`);
    return { kind: 'char', c };
  };
  const set = () => {
    const ranges = [];
    const not = src[i] === '^';
    if (not) i++;
    while (src[i] !== ']') {
      if (i >= src.length) fail('an unclosed [');
      const lo = src[i] === '\\' ? (i++, escape()) : { kind: 'char', c: src[i++] };
      if (lo.kind === 'set') { ranges.push(...lo.ranges); continue; }
      if (lo.kind !== 'char') fail('a backreference in a set');
      if (src[i] === '-' && src[i + 1] !== ']' && i + 1 < src.length) {
        i++;
        const hi = src[i] === '\\' ? (i++, escape()) : { kind: 'char', c: src[i++] };
        if (hi.kind !== 'char' || hi.c < lo.c) fail('a bad range');
        ranges.push([lo.c, hi.c]);
      } else ranges.push([lo.c, lo.c]);
    }
    i++;
    return { kind: 'set', ranges, not };
  };
  const count = (atom) => {
    let [min, max] = [1, 1];
    if (src[i] === '+') [min, max] = [1, Infinity];
    else if (src[i] === '*') [min, max] = [0, Infinity];
    else if (src[i] === '?') [min, max] = [0, 1];
    else if (src[i] === '{') {
      const close = src.indexOf('}', i);
      const m = close === -1 ? null : /^(\d+)(?:(,)(\d*))?$/.exec(src.slice(i + 1, close));
      if (!m) fail('a bad {n,m}');
      min = Number(m[1]);
      max = !m[2] ? min : m[3] ? Number(m[3]) : Infinity;
      i = close;
    } else return { ...atom, min, max };
    i++;
    if ('+*?{'.includes(src[i] ?? '')) fail('a count after a count');
    return { ...atom, min, max };
  };
  // One alternative: atoms up to a | or ) (or the end, or a final $ at the top).
  const sequence = (top) => {
    const atoms = [];
    while (i < src.length && src[i] !== '|' && src[i] !== ')') {
      const c = src[i++];
      if (top && c === '$' && i === src.length) { i--; break; }
      let atom;
      if (c === '\\') atom = escape();
      else if (c === '.') atom = { kind: 'any' };
      else if (c === '[') atom = set();
      else if (c === '(') {
        if (src[i] === '?') fail('only plain ( ) groups');
        const n = ++groups;
        const alts = alternatives(false);
        if (src[i++] !== ')') fail('an unclosed (');
        atom = { kind: 'group', n, alts };
      } else if ('^$*+?{}]'.includes(c)) fail(`a stray ${c}`);
      else atom = { kind: 'char', c };
      atoms.push(count(atom));
    }
    return atoms;
  };
  const alternatives = (top) => {
    const alts = [sequence(top)];
    while (src[i] === '|') { i++; alts.push(sequence(top)); }
    return alts;
  };
  const start = src[0] === '^';
  if (start) i++;
  const alts = alternatives(true);
  if (src[i] === ')') fail('a stray )');
  const end = src[i] === '$';
  if ((start || end) && alts.length > 1) fail('^ or $ around a bare | (wrap the choice in a group)');
  return { start, end, groups, root: { kind: 'group', n: 0, alts, min: 1, max: 1 } };
}

const same = (a, b) => a === b || a.toLowerCase() === b.toLowerCase();
const inSet = (ranges, c) => [c, c.toLowerCase(), c.toUpperCase()].some((x) => ranges.some(([lo, hi]) => x >= lo && x <= hi));

// One repetition of an atom at text[i]: the index after it, or -1.
function step(atom, text, i, caps) {
  if (atom.kind === 'group') {
    for (const alt of atom.alts) {
      let j = i;
      for (const a of alt) if ((j = repeat(a, text, j, caps)) === -1) break;
      if (j !== -1) { caps[atom.n] = text.slice(i, j); return j; }
    }
    return -1;
  }
  if (atom.kind === 'ref') {
    const seen = caps[atom.n] ?? '';
    const here = text.slice(i, i + seen.length);
    return here.length === seen.length && [...seen].every((c, k) => same(c, here[k])) ? i + seen.length : -1;
  }
  if (i >= text.length) return -1;
  const c = text[i];
  if (atom.kind === 'any') return c === '\n' || c === '\r' ? -1 : i + 1;
  if (atom.kind === 'set') return inSet(atom.ranges, c) !== Boolean(atom.not) ? i + 1 : -1;
  return same(atom.c, c) ? i + 1 : -1;
}

function repeat(atom, text, i, caps) {
  let n = 0;
  while (n < atom.max) {
    const j = step(atom, text, i, caps);
    if (j === -1 || (j === i && n >= atom.min)) break;
    i = j;
    n++;
  }
  return n < atom.min ? -1 : i;
}

const compiled = new Map();
// Like RegExp's exec with the i flag: [whole match, ...groups], or null.
export function matchPattern(pattern, text) {
  if (!compiled.has(pattern)) compiled.set(pattern, parsePattern(pattern));
  const p = compiled.get(pattern);
  const s = String(text);
  for (let from = 0; from <= (p.start ? 0 : s.length); from++) {
    const caps = [];
    const to = step(p.root, s, from, caps);
    if (to !== -1 && (!p.end || to === s.length)) return Array.from({ length: p.groups + 1 }, (_, k) => caps[k]);
  }
  return null;
}

// Does a real exchange match an outcome's "when"? status: number or list;
// headers: name -> pattern over response headers plus headers the origin echoed
// in the body; json: dot path -> pattern over the parsed body (see matchPattern).
export function matches(when = {}, exchange) {
  if (when.status !== undefined && ![].concat(when.status).includes(exchange.status)) return false;
  for (const [name, re] of Object.entries(when.headers ?? {})) {
    const value = exchange.headers.get(name.toLowerCase());
    if (value === undefined || !matchPattern(re, value)) return false;
  }
  for (const [path, re] of Object.entries(when.json ?? {})) {
    const value = path.split('.').reduce((node, k) => (node == null ? undefined : node[k]), exchange.json);
    if (value === undefined || !matchPattern(re, typeof value === 'object' ? JSON.stringify(value) : String(value))) return false;
  }
  return true;
}

export function pickOutcome(outcomes = [], exchange) {
  return outcomes.find((o) => matches(o.when, exchange)) ?? null;
}
