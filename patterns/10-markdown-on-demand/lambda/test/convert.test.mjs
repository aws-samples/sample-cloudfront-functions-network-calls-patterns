// Runs with: npm ci && npm test from lambda/ (turndown must be installed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toMarkdown } from '../convert.mjs';

test('main content only, title as front matter, no scripts or navigation', () => {
  const html = '<html><head><title>Guide</title><style>p{}</style></head><body><nav><a href="/">Home</a></nav>' +
    '<main><h1>Hi</h1><p>Some <b>bold</b> <a href="x.html">link</a></p><pre><code>npm ci</code></pre><ul><li>a</li></ul>' +
    '<script>x()</script></main></body></html>';
  assert.equal(toMarkdown(html), '---\ntitle: "Guide"\n---\n\n# Hi\n\nSome **bold** [link](x.html)\n\n```\nnpm ci\n```\n\n-   a\n');
});

test('no <main>: the body; no title: no front matter', () => {
  assert.equal(toMarkdown('<body><h2>Only</h2></body>'), '## Only\n');
});

test('the seeded demo pages convert', () => {
  const md = toMarkdown(readFileSync(new URL('../../objects/patterns/markdown-on-demand/guide.html', import.meta.url), 'utf8'));
  assert.match(md, /^---\ntitle: /);
  assert.match(md, /^# /m);
  assert.doesNotMatch(md, /<(nav|script|p|h1)\b|Home/);
});
