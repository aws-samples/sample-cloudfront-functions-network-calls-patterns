#!/usr/bin/env node
// CloudFront Functions runtime 2.0 rejects `await` inside call arguments at COMPILE time
// ("SyntaxError: await in arguments not supported"), e.g. JSON.parse(await res.text()).
// Node accepts it, so unit tests pass and only the deployed function fails (503).
// Fix: assign first — `const text = await res.text(); JSON.parse(text);`.
//
// A small tokenizer tracks open brackets. An `await` is flagged when a call's `(` is open
// between it and the nearest enclosing function body. That covers await inside template
// literals, array/object literals and ternaries passed as arguments. `if (`, `for (`,
// `while (`, `switch (`, `return (` and plain grouping parens are not calls.
//
// Usage: node scripts/check-no-await-in-args.mjs [file ...]   (default: every pattern function)
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// An identifier before `(` makes it a call unless it is one of these.
const NOT_CALLEE = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'void', 'delete', 'await', 'in', 'of',
  'instanceof', 'function', 'async', 'yield', 'case', 'else', 'do', 'throw', 'with',
]);
// After these tokens a `/` starts a regex literal rather than a division.
const VALUE_END = /^([A-Za-z_$][\w$]*|\d[\w.]*|\)|\])$/;

export function findAwaitInArgs(src) {
  const hits = [];
  // Frames: 'call' | 'group' | 'params' | 'bracket' | 'brace' | 'fnbody' | 'tpl' (a `${`).
  const stack = [];
  let prev = '';
  let prev2 = '';
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (n) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') { line++; col = 1; } else col++;
      i++;
    }
  };
  const inCall = () => {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k] === 'fnbody') return false;
      if (stack[k] === 'call') return true;
    }
    return false;
  };
  // Scans the literal part of a template; stops after the closing backtick or after `${`.
  const scanTemplate = () => {
    while (i < src.length) {
      if (src[i] === '\\') { advance(2); continue; }
      if (src[i] === '`') { advance(1); return 'end'; }
      if (src[i] === '$' && src[i + 1] === '{') { advance(2); return 'expr'; }
      advance(1);
    }
    return 'end';
  };
  const token = (t) => { prev2 = prev; prev = t; };

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (/\s/.test(c)) { advance(1); continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') advance(1); continue; }
    if (c === '/' && n === '*') { advance(2); while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) advance(1); advance(2); continue; }
    if (c === '"' || c === "'") {
      advance(1);
      while (i < src.length && src[i] !== c && src[i] !== '\n') advance(src[i] === '\\' ? 2 : 1);
      advance(1);
      token('str');
      continue;
    }
    if (c === '`') {
      advance(1);
      if (scanTemplate() === 'expr') { stack.push('tpl'); token('${'); } else token('str');
      continue;
    }
    if (c === '/' && !VALUE_END.test(prev)) {
      advance(1);
      let inClass = false;
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '\\') { advance(2); continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        advance(1);
      }
      advance(1);
      while (/[a-z]/i.test(src[i] ?? '')) advance(1);
      token('regex');
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 64));
    if (word) {
      if (word[0] === 'await' && inCall()) {
        const text = src.split('\n')[line - 1].trim();
        hits.push({ line, col, text });
      }
      advance(word[0].length);
      token(word[0]);
      continue;
    }
    const num = /^\d[\w.]*/.exec(src.slice(i, i + 64));
    if (num) { advance(num[0].length); token(num[0]); continue; }
    if (c === '=' && n === '>') { advance(2); token('=>'); continue; }
    if (c === '(') {
      let kind = 'group';
      if (prev2 === 'function' || (prev === 'function')) kind = 'params';
      else if (/^[A-Za-z_$][\w$]*$/.test(prev) && !NOT_CALLEE.has(prev)) kind = 'call';
      else if (prev === ')' || prev === ']') kind = 'call';
      stack.push(kind);
      advance(1);
      token('(');
      continue;
    }
    if (c === '[') { stack.push('bracket'); advance(1); token('['); continue; }
    if (c === '{') {
      // A brace after `)` or `=>` opens a function body or block; anything else is an object literal.
      stack.push(prev === ')' || prev === '=>' || prev === 'else' || prev === 'try' || prev === 'finally' || prev === '' || prev === ';' || prev === '}' || prev === '{' ? 'fnbody' : 'brace');
      advance(1);
      token('{');
      continue;
    }
    if (c === ')' || c === ']') { stack.pop(); advance(1); token(c); continue; }
    if (c === '}') {
      const top = stack.pop();
      advance(1);
      if (top === 'tpl') {
        if (scanTemplate() === 'expr') { stack.push('tpl'); token('${'); } else token('str');
      } else token('}');
      continue;
    }
    advance(1);
    token(c);
  }
  return hits;
}

function defaultFiles() {
  const files = [];
  for (const folder of readdirSync('patterns')) {
    for (const name of ['function.js', 'response-function.js']) {
      const file = join('patterns', folder, name);
      if (existsSync(file)) files.push(file);
    }
  }
  return files;
}

const files = process.argv.length > 2 ? process.argv.slice(2) : defaultFiles();
let failed = false;
for (const file of files) {
  const hits = findAwaitInArgs(readFileSync(file, 'utf8'));
  failed ||= hits.length > 0;
  if (!hits.length) console.log(`✔ ${file}: no await inside call arguments`);
  for (const h of hits) console.error(`✖ ${file}:${h.line}:${h.col}: await inside call arguments (CloudFront Functions rejects it; assign to a const first)\n    ${h.text}`);
}
process.exit(failed ? 1 : 0);
