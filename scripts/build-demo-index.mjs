#!/usr/bin/env node
// Collect every patterns/<nn>-<name>/demo.json into demo/patterns.json.
// Each entry also carries the pattern's sequence diagram (demo.json "diagram",
// else the first mermaid block of the pattern README), and every demo.json
// "outcomes" rule is checked against that diagram so the page can animate it.
// It also carries the pattern's function code, read from the very files the stack
// deploys, so the page's code panel shows what CloudFront runs.
// Idempotent: run it as often as you like.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseSequence, resolvePath, stepsNamed } from '../demo/sequence.js';
import { STAGES, LANES, flowGraph, layoutFlow, checkLayout } from '../demo/flow-layout.js';

const REQUIRED = ['id', 'title', 'summary', 'lesson', 'tryPath', 'method', 'expect'];
const HOOKS = ['viewer-request', 'viewer-response'];
// Optional demo.json "tags": the demo page filters on them.
const TAGS = ['ai-gateway', 'agents', 'auth', 'routing', 'telemetry', 'resilience', 'config'];
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const TONES = ['ok', 'warn', 'bad'];

const patterns = [];
for (const folder of readdirSync('patterns').sort()) {
  const m = /^(\d{2})-([a-z0-9-]+)$/.exec(folder);
  if (!m) continue;
  const file = join('patterns', folder, 'demo.json');
  if (!existsSync(file)) {
    console.warn(`- ${folder}: no demo.json, skipped`);
    continue;
  }
  const demo = JSON.parse(readFileSync(file, 'utf8'));
  const missing = REQUIRED.filter((k) => !(k in demo));
  if (missing.length) throw new Error(`${file}: missing ${missing.join(', ')}`);
  if (demo.id !== m[2]) throw new Error(`${file}: id "${demo.id}" must equal folder name without prefix ("${m[2]}")`);
  const hooks = demo.hooks ?? ['viewer-request'];
  const badHook = hooks.find((h) => !HOOKS.includes(h));
  if (badHook) throw new Error(`${file}: unknown hook "${badHook}" (allowed: ${HOOKS.join(', ')})`);
  const tags = demo.tags ?? [];
  if (!Array.isArray(tags)) throw new Error(`${file}: "tags" must be an array`);
  const badTag = tags.find((t) => !TAGS.includes(t));
  if (badTag !== undefined) throw new Error(`${file}: unknown tag "${badTag}" (allowed: ${TAGS.join(', ')})`);
  const diagram = readDiagram(folder, demo, file);
  checkRequests(demo, file);
  checkOutcomes(demo, diagram, file);
  checkFrames(demo, diagram, file);
  checkStory(demo, diagram, file);
  checkFlow(demo, diagram, file);
  const code = readCode(folder, hooks);
  patterns.push({ number: m[1], folder, ...demo, hooks, tags, diagram, code });
  console.log(`✔ ${folder}`);
}

// demo.json "diagram" (string or array of lines) wins; otherwise the README's mermaid sequenceDiagram block
// (the Architecture flowchart comes first in the README and is skipped).
function readDiagram(folder, demo, file) {
  let source = Array.isArray(demo.diagram) ? demo.diagram.join('\n') : demo.diagram;
  if (source === undefined) {
    const readme = join('patterns', folder, 'README.md');
    const block = existsSync(readme) && /```mermaid\n(\s*sequenceDiagram\b[\s\S]*?)```/.exec(readFileSync(readme, 'utf8'));
    if (!block) throw new Error(`${file}: no "diagram" and no mermaid sequenceDiagram block in ${readme}`);
    source = block[1];
  }
  source = source.trimEnd();
  if (!/^\s*sequenceDiagram\b/.test(source)) throw new Error(`${file}: the diagram must be a mermaid sequenceDiagram`);
  try {
    if (!parseSequence(source).steps.length) throw new Error('no messages');
  } catch (e) {
    throw new Error(`${file}: diagram: ${e.message}`);
  }
  return source;
}

// The function code the page shows beside the flow: function.js, and
// response-function.js for a pattern with a viewer-response function. pattern.ts must
// deploy exactly these files, so the page can never show code that does not run.
function readCode(folder, hooks) {
  const files = { 'viewer-request': ['function.js', 'functionCode'], 'viewer-response': ['response-function.js', 'responseFunctionCode'] };
  const dir = join('patterns', folder);
  const stack = existsSync(join(dir, 'pattern.ts')) ? readFileSync(join(dir, 'pattern.ts'), 'utf8') : '';
  return Object.entries(files).flatMap(([hook, [name, key]]) => {
    const path = join(dir, name);
    const declared = new RegExp(`\\b${key}:\\s*path\\.join\\(__dirname,\\s*'${name}'\\)`).test(stack);
    if (!hooks.includes(hook)) {
      if (existsSync(path) || declared) throw new Error(`${dir}: ${name} exists or pattern.ts deploys it, but demo.json "hooks" has no ${hook}`);
      return [];
    }
    if (!existsSync(path)) throw new Error(`${dir}: demo.json "hooks" has ${hook}, but ${name} is missing`);
    if (!declared) throw new Error(`${dir}/pattern.ts: ${key} must be path.join(__dirname, '${name}'), the file the demo page shows`);
    return [{ hook, file: name, path: `patterns/${folder}/${name}`, source: readFileSync(path, 'utf8') }];
  });
}

// Optional demo.json "requests": one Try button each, merged over tryPath/method/body.
function checkRequests(demo, file) {
  if (!METHODS.includes(demo.method)) throw new Error(`${file}: unknown method "${demo.method}"`);
  if (demo.requests === undefined) return;
  if (!Array.isArray(demo.requests) || !demo.requests.length) throw new Error(`${file}: "requests" must be a non-empty array`);
  for (const [i, r] of demo.requests.entries()) {
    if (typeof r.label !== 'string' || !r.label) throw new Error(`${file}: requests[${i}] needs a "label"`);
    if (r.method !== undefined && !METHODS.includes(r.method)) throw new Error(`${file}: requests[${i}]: unknown method "${r.method}"`);
    if (r.path !== undefined && !r.path.startsWith(`/patterns/${demo.id}/`)) throw new Error(`${file}: requests[${i}]: path must stay under /patterns/${demo.id}/`);
    // "bearerFrom": the page GETs this path for { access_token } and sends it as Authorization: Bearer.
    if (r.bearerFrom !== undefined && !String(r.bearerFrom).startsWith(`/patterns/${demo.id}/`)) throw new Error(`${file}: requests[${i}]: bearerFrom must stay under /patterns/${demo.id}/`);
  }
}

// Optional demo.json "outcomes": each "take" label must name exactly one branch,
// and every alt the path reaches must be decided, or the page would guess.
function checkOutcomes(demo, diagram, file) {
  if (demo.outcomes === undefined) return;
  if (!Array.isArray(demo.outcomes)) throw new Error(`${file}: "outcomes" must be an array`);
  const model = parseSequence(diagram);
  for (const [i, o] of demo.outcomes.entries()) {
    const where = `${file}: outcomes[${i}]`;
    if (typeof o.label !== 'string' || !o.label) throw new Error(`${where} needs a "label"`);
    if (o.tone !== undefined && !TONES.includes(o.tone)) throw new Error(`${where}: tone must be one of ${TONES.join(', ')}`);
    for (const re of [...Object.values(o.when?.headers ?? {}), ...Object.values(o.when?.json ?? {})]) new RegExp(re);
    if (o.stopAfter !== undefined && typeof o.stopAfter !== 'string') throw new Error(`${where}: "stopAfter" must be a branch label`);
    if (o.lastStep !== undefined && !Number.isInteger(o.lastStep)) throw new Error(`${where}: "lastStep" must be a message number`);
    if (o.take !== undefined && (!Array.isArray(o.take) || o.take.some((t) => typeof t !== 'string' || !t))) throw new Error(`${where}: "take" must be a list of branch labels`);
    if (o.skip !== undefined && (!Array.isArray(o.skip) || o.skip.some((t) => typeof t !== 'string' || !t))) throw new Error(`${where}: "skip" must be a list of step text prefixes`);
    const { errors, undecided } = resolvePath(model, o);
    if (errors.length) throw new Error(`${where}: ${errors.join('; ')}`);
    if (undecided.length) throw new Error(`${where}: does not decide ${undecided.map((l) => `"alt ${l}"`).join(', ')}`);
  }
}

// Optional request "frame": a real page load in a frame on the page (11's waiting
// room needs a person for its CAPTCHA). Each state says how to recognise the frame's
// page (selector, title, text or JSON), which milestone it reaches and, like an outcome,
// which path of the diagram it has taken so far.
function checkFrames(demo, diagram, file) {
  const model = parseSequence(diagram);
  for (const [i, r] of (demo.requests ?? []).entries()) {
    if (r.frame === undefined) continue;
    const where = `${file}: requests[${i}].frame`;
    const { milestones, states } = r.frame;
    if (!Array.isArray(milestones) || !milestones.length || milestones.some((m) => typeof m !== 'string' || !m)) throw new Error(`${where}: "milestones" must be a list of names`);
    if (!Array.isArray(states) || !states.length) throw new Error(`${where}: "states" must be a non-empty list`);
    // skipUnlessSeen: [{ seen: [state ids], steps: [steps], note }]. Those steps ran only if the
    // frame saw one of those states on this visit; otherwise every replay leaves them out (a
    // visitor who already held a ticket gets no CAPTCHA and no ticket machine) and shows the note.
    const unless = r.frame.skipUnlessSeen ?? [];
    if (!Array.isArray(unless)) throw new Error(`${where}: "skipUnlessSeen" must be a list of { seen, steps, note }`);
    for (const [k, e] of unless.entries()) {
      const at = `${where}.skipUnlessSeen[${k}]`;
      if (!Array.isArray(e.seen) || !e.seen.length || e.seen.some((id) => !states.some((o) => o.id === id))) throw new Error(`${at}: "seen" must list state ids`);
      if (!Array.isArray(e.steps) || !e.steps.length || e.steps.some((t) => typeof t !== 'string' || !t)) throw new Error(`${at}: "steps" must be a list of steps`);
      for (const t of e.steps) if (!stepsNamed(model, t).length) throw new Error(`${at}: "${t}" matches no step`);
      if (e.note !== undefined && (typeof e.note !== 'string' || !e.note)) throw new Error(`${at}: "note" must be a sentence`);
    }
    for (const [j, st] of states.entries()) {
      const at = `${where}.states[${j}]`;
      if (typeof st.id !== 'string' || !st.id || typeof st.label !== 'string' || !st.label) throw new Error(`${at} needs an "id" and a "label"`);
      if (!Number.isInteger(st.milestone) || st.milestone < 0 || st.milestone >= milestones.length) throw new Error(`${at}: "milestone" must index "milestones"`);
      const w = st.when ?? {};
      if (!['selector', 'title', 'text', 'json'].some((k) => k in w)) throw new Error(`${at}: "when" needs a selector, title, text or json`);
      for (const re of [w.title, w.text, ...Object.values(w.json ?? {})].filter((v) => v !== undefined)) new RegExp(re);
      if (st.tone !== undefined && !TONES.includes(st.tone)) throw new Error(`${at}: tone must be one of ${TONES.join(', ')}`);
      if (st.skipUnlessSeen !== undefined) throw new Error(`${at}: "skipUnlessSeen" belongs on the frame, as a list of { seen, steps, note }`);
      // Both ends of what a visit can show: everything seen, and this state the only one seen.
      const alone = unless.filter((e) => !e.seen.includes(st.id)).flatMap((e) => e.steps);
      for (const variant of [st, { ...st, drop: alone }]) {
        const { taken, errors, undecided } = resolvePath(model, variant);
        if (errors.length) throw new Error(`${at}: ${errors.join('; ')}`);
        if (undecided.length) throw new Error(`${at}: does not decide ${undecided.map((l) => `"alt ${l}"`).join(', ')}`);
        if (!taken.some(Boolean)) throw new Error(`${at}: the replay keeps no step when only "${st.id}" is seen`);
      }
    }
  }
}

// Optional demo.json "gist" (the pattern in one plain sentence), "actors"
// (participant id -> { name, icon, at, service, access } or a name; "at" places it on the
// edge loop, "service" and "access" describe it in the Know-how view) and "story" (one short sentence
// per diagram step, notes included, in diagram order) drive the page's default
// "What happens" view. A step count that drifts from the diagram is an error.
function checkStory(demo, diagram, file) {
  const model = parseSequence(diagram);
  const ids = model.participants.map((x) => x.id);
  if (demo.gist !== undefined && (typeof demo.gist !== 'string' || !demo.gist)) throw new Error(`${file}: "gist" must be a sentence`);
  if (demo.cachePolicy !== undefined && (typeof demo.cachePolicy !== 'string' || !demo.cachePolicy)) throw new Error(`${file}: "cachePolicy" must be a policy name`);
  if (demo.waf !== undefined && (typeof demo.waf !== 'string' || !demo.waf)) throw new Error(`${file}: "waf" must say what the web ACL does on this path`);
  const unknown = Object.keys(demo.actors ?? {}).filter((id) => !ids.includes(id));
  if (unknown.length) throw new Error(`${file}: actors ${unknown.join(', ')} not in the diagram (participants: ${ids.join(', ')})`);
  for (const [id, a] of Object.entries(demo.actors ?? {})) {
    const ok = typeof a === 'string' ? a.length > 0 : a && typeof a.name === 'string' && a.name && (a.icon === undefined || typeof a.icon === 'string');
    if (!ok) throw new Error(`${file}: actors.${id} must be a name or { "name": "...", "icon": "...", "at": "..." }`);
    if (typeof a === 'object' && a.at !== undefined && !STAGES.includes(a.at)) throw new Error(`${file}: actors.${id}.at "${a.at}" (allowed: ${STAGES.join(', ')})`);
    if (typeof a === 'object' && a.lane !== undefined && !LANES.includes(a.lane)) throw new Error(`${file}: actors.${id}.lane "${a.lane}" (allowed: ${LANES.join(', ')})`);
    if (typeof a === 'object' && a.lane !== undefined && a.at !== 'backend') throw new Error(`${file}: actors.${id}.lane needs "at": "backend" (only what sits behind an origin runs in the background)`);
    for (const k of ['service', 'access']) if (typeof a === 'object' && a[k] !== undefined && (typeof a[k] !== 'string' || !a[k])) throw new Error(`${file}: actors.${id}.${k} must be text`);
  }
  if (demo.story === undefined) return;
  if (!Array.isArray(demo.story) || demo.story.some((s) => typeof s !== 'string' || !s)) throw new Error(`${file}: "story" must be an array of sentences`);
  if (demo.story.length !== model.steps.length) {
    throw new Error(`${file}: "story" has ${demo.story.length} sentences, the diagram has ${model.steps.length} steps (messages and notes)`);
  }
}

// The "What happens" view (demo/flow-layout.js) lays the pattern out on CloudFront's
// path: every connector right-angled, none through a box or on top of another, every
// network call labelled. Checked at two station heights, since fonts and text vary.
function checkFlow(demo, diagram, file) {
  const model = parseSequence(diagram);
  const graph = flowGraph({ ...demo, hooks: demo.hooks ?? ['viewer-request'] }, model);
  for (const h of [100, 124]) {
    const problems = checkLayout(layoutFlow(graph, { h }), graph);
    if (problems.length) throw new Error(`${file}: the What happens layout (station height ${h}): ${problems.join('; ')}`);
  }
}

writeFileSync('demo/patterns.json', JSON.stringify(patterns, null, 2) + '\n');
console.log(`demo/patterns.json: ${patterns.length} pattern(s)`);

