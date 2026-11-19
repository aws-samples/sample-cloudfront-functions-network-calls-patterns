// node --test scripts/flow-layout.test.mjs
// The demo's "What happens" view (demo/flow-layout.js) must draw every pattern like an AWS
// architecture diagram: right-angled connectors, none through a box, none on top of
// another, every network call labelled, the lanes in CloudFront's order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSequence } from '../demo/sequence.js';
import { routes, flowGraph, layoutFlow, checkLayout } from '../demo/flow-layout.js';

const patterns = JSON.parse(readFileSync('demo/patterns.json', 'utf8'));

for (const p of patterns) {
  const model = parseSequence(p.diagram);
  const graph = flowGraph(p, model);
  for (const h of [100, 124, 150]) {
    test(`${p.number} ${p.id}: clean layout at station height ${h}`, () => {
      assert.deepEqual(checkLayout(layoutFlow(graph, { h }), graph), []);
    });
  }
  test(`${p.number} ${p.id}: the request path runs left to right`, () => {
    const L = layoutFlow(graph);
    const x = (k) => L.boxes.get(k).x;
    assert.ok(x('viewer') < x('tls') && x('tls') < x('waf') && x('waf') < x('vr') && x('vr') < x('cache'));
    for (const [k, b] of L.boxes) if (k.startsWith('origin:')) assert.ok(b.x > x('cache'), `${k} sits right of the cache`);
  });
  test(`${p.number} ${p.id}: every step rides connectors that exist`, () => {
    const L = layoutFlow(graph);
    routes(p, model).forEach((r, i) => {
      for (const l of graph.legsOf(r)) assert.ok(L.paths.has(l.id), `step ${i + 1}: ${l.id}`);
    });
  });
}

test('network calls get their own connector type and label', () => {
  const p = patterns.find((x) => x.id === 'hello-fetch');
  const graph = flowGraph(p, parseSequence(p.diagram));
  const call = graph.legs.find((l) => l.type === 'call');
  assert.equal(call.label, 'cf.fetch');
  assert.ok(call.arrowA && call.arrowB, 'the call and its reply share one two-way connector');
});

test('background workers sit in their own row, under the lanes', () => {
  const p = patterns.find((x) => x.id === 'edge-waiting-room');
  const graph = flowGraph(p, parseSequence(p.diagram));
  const L = layoutFlow(graph);
  const bg = L.groups.find((g) => g.kind === 'background');
  assert.ok(bg && bg.t > L.boxes.get('cache').b, 'the background group is below the cache');
  assert.ok(graph.legs.filter((l) => l.a === 'backend:L' || l.b === 'backend:L').every((l) => l.type === 'bg'));
});
