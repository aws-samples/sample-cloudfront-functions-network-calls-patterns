#!/usr/bin/env node
// Installs the dependencies of every pattern origin that has its own package-lock.json
// (patterns/<nn>-<name>/lambda, and patterns/01-cognito-auth/token), so a fresh clone can run
// `npm test` after `npm ci`. Runs as the root package's postinstall; `cdk synth` bundles each
// origin with its own `npm ci` and does not depend on this.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const patterns = path.join(root, 'patterns');

for (const pattern of readdirSync(patterns).filter((d) => /^\d\d-/.test(d)).sort()) {
  for (const sub of ['lambda', 'token']) {
    const dir = path.join(patterns, pattern, sub);
    if (!existsSync(path.join(dir, 'package-lock.json'))) continue;
    console.log(`npm ci in patterns/${pattern}/${sub}`);
    execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, stdio: 'inherit' });
  }
}
