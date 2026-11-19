#!/usr/bin/env node
// CloudFront Functions are capped at 10 KB of source. Fail early instead of at deploy time.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LIMIT = 10 * 1024;
let failed = false;
// function.js = viewer-request, response-function.js = optional viewer-response (both capped).
for (const folder of readdirSync('patterns')) {
  for (const name of ['function.js', 'response-function.js']) {
    const file = join('patterns', folder, name);
    try {
      const size = statSync(file).size;
      const ok = size <= LIMIT;
      failed ||= !ok;
      console.log(`${ok ? '✔' : '✖'} ${file}: ${size} bytes${ok ? '' : ` (limit ${LIMIT})`}`);
    } catch { /* folder without that function */ }
  }
}
process.exit(failed ? 1 : 0);
