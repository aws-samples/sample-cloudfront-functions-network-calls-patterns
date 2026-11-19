#!/usr/bin/env node
// CloudFront Functions runtime 2.0 rejects `for (... of ...)` at COMPILE time
// ("SyntaxError: Token "of" not supported in this version"). Node accepts it and publishing the
// function succeeds, so unit tests pass and every request to the deployed function is a 503.
// Fix: an index loop, or Array methods (some, find, forEach).
//
// Usage: node scripts/check-no-for-of.mjs [file ...]   (default: every pattern function)
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Comments and string literals blanked out, line breaks kept, so line numbers still match.
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, '')
  .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, (m) => m.replace(/[^\n]/g, ' '));

export function findForOf(src) {
  const hits = [];
  code(src).split('\n').forEach((line, n) => {
    if (/\bfor\s*(await\s*)?\(\s*(const|let|var)?\s*[\w$[\]{},\s]+\s+of\s/.test(line)) hits.push(n + 1);
  });
  return hits;
}

const files = process.argv.length > 2 ? process.argv.slice(2) : readdirSync('patterns')
  .flatMap((d) => ['function.js', 'response-function.js'].map((f) => join('patterns', d, f)))
  .filter(existsSync);
let failed = false;
for (const file of files) {
  const hits = findForOf(readFileSync(file, 'utf8'));
  failed ||= hits.length > 0;
  console.log(hits.length ? `✖ ${file}: for...of on line ${hits.join(', ')}` : `✔ ${file}: no for...of`);
}
process.exit(failed ? 1 : 0);
