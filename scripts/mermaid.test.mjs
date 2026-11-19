// node --test scripts/mermaid.test.mjs
// Every ```mermaid block in the repo's Markdown must parse, or GitHub shows the raw source instead of
// a diagram.
// Example trap: a ';' in a message ends the statement ("Parse error ... got ','").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { default: mermaid } = await import('mermaid');
mermaid.initialize({ startOnLoad: false });


const files = ['README.md', 'docs/adding-a-pattern.md',
  ...readdirSync('docs').filter((f) => f.endsWith('.md')).map((f) => join('docs', f)),
  ...readdirSync('patterns').map((d) => join('patterns', d, 'README.md')).filter(existsSync)];
const blocks = files.flatMap((file) =>
  [...readFileSync(file, 'utf8').matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m, i) => ({ file, i, src: m[1] })));

for (const { file, i, src } of blocks) {
  test(`${file} mermaid block ${i + 1} parses`, async () => {
    await assert.doesNotReject(mermaid.parse(src));
  });
  test(`${file} mermaid block ${i + 1}: no # in a message (Mermaid drops the rest of the label)`, () => {
    // Observed with 11.17.2: "issue #42 done" renders as "issue". Write #35; for a literal #.
    const cut = src.split('\n').filter((l) => /^\s*\w+\s*[-=.<>)x+]+\s*\w+\s*:/.test(l) && /#(?!\d+;)/.test(l.slice(l.indexOf(':'))));
    assert.deepEqual(cut, []);
  });
}
