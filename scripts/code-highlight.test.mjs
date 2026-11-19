// node --test scripts/code-highlight.test.mjs
// The demo page shows each pattern's function code beside the flow (demo/code.js
// highlights it). What it shows must be the deployed file byte for byte, and the
// highlighter must not lose or reorder a character on the way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tokenize, highlight } from '../demo/code.js';

const patterns = JSON.parse(readFileSync('demo/patterns.json', 'utf8'));

for (const p of patterns) {
  test(`${p.number} ${p.id}: the page carries the deployed function files`, () => {
    assert.deepEqual(p.code.map((c) => c.hook), p.hooks);
    for (const c of p.code) assert.equal(c.source, readFileSync(c.path, 'utf8'), `${c.path} in patterns.json is stale: run npm run demo:index`);
  });
  for (const c of p.code) {
    test(`${c.path}: highlighting keeps every character`, () => {
      assert.equal(tokenize(c.source).map(([, t]) => t).join(''), c.source);
      const lines = highlight(c.source);
      assert.equal(lines.length, c.source.split('\n').length);
      assert.equal(lines.map((l) => l.map(([, t]) => t).join('')).join('\n'), c.source);
    });
  }
}

test('comments, strings, regexes, numbers and keywords get their kinds', () => {
  const kinds = (src) => tokenize(src).filter(([k]) => k).map(([k, t]) => `${k}:${t}`);
  assert.deepEqual(kinds("const a = 'x'; // note"), ['kw:const', "str:'x'", 'com:// note']);
  assert.deepEqual(kinds('if (/^Bearer /i.test(h)) return 1 / 2;'), ['kw:if', 're:/^Bearer /i', 'fn:test', 'kw:return', 'num:1', 'num:2']);
  assert.deepEqual(kinds('const t = `a ${b ? `c` : "}"} d`;'), ['kw:const', 'str:`a ${b ? `c` : "}"} d`']);
  assert.deepEqual(kinds('async function handler(event) { await cf.fetch(u); }'), ['kw:async', 'kw:function', 'fn:handler', 'kw:await', 'fn:fetch']);
  assert.deepEqual(kinds('x.default = null;'), ['lit:null']);
});
