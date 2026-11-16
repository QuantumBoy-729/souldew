#!/usr/bin/env node
// Copies what the Android app runs into android/app/src/main/assets/souldew:
// server/, shared/, web/, package.json and the production node_modules (no Electron, no tools/).
// Usage: node scripts/android-assets.mjs
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'android', 'app', 'src', 'main', 'assets', 'souldew');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const dir of ['server', 'shared', 'web']) cpSync(join(root, dir), join(out, dir), { recursive: true });
copyFileSync(join(root, 'package.json'), join(out, 'package.json'));

// production dependencies only, installed in a scratch folder so the repo's node_modules stays untouched
const scratch = mkdtempSync(join(tmpdir(), 'souldew-android-'));
try {
  copyFileSync(join(root, 'package.json'), join(scratch, 'package.json'));
  if (existsSync(join(root, 'package-lock.json'))) copyFileSync(join(root, 'package-lock.json'), join(scratch, 'package-lock.json'));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: scratch, stdio: 'inherit', shell: process.platform === 'win32' });
  cpSync(join(scratch, 'node_modules'), join(out, 'node_modules'), { recursive: true });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const size = (p) => readdirSync(p, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(join(p, e.name)) : statSync(join(p, e.name)).size), 0);
console.log(`assets ready: ${out} (${(size(out) / 1048576).toFixed(1)} MB)`);
