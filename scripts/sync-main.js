#!/usr/bin/env node
// Concatenates core/*.js, strips ESM import/export, splices into main.js
// between <core-injected> markers. Idempotent. Use --check for CI.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIR = resolve(ROOT, 'core');
const MAIN_JS = resolve(ROOT, 'main.js');
const START = '// <core-injected>';
const END = '// </core-injected>';

// Order matters: declarations must precede uses within the IIFE.
const CORE_ORDER = [
  'prompts.js',
  'parsing.js',
  'urls.js',
  'claim.js',
  'providers.js',
  'worker.js',
];

function stripEsm(source) {
  return source
    .split('\n')
    .filter(line => !/^\s*import\b/.test(line))
    .map(line => line
      .replace(/^(\s*)export\s+(async\s+)?function\b/, '$1$2function')
      .replace(/^(\s*)export\s+const\b/, '$1const')
      .replace(/^(\s*)export\s+\{[^}]*\};?\s*$/, ''))
    .join('\n');
}

function buildInjected() {
  return CORE_ORDER
    .map(name => `// --- core/${name} ---\n${stripEsm(readFileSync(resolve(CORE_DIR, name), 'utf8')).trim()}`)
    .join('\n\n');
}

function splice(main, injected) {
  const startIdx = main.indexOf(START);
  const endIdx = main.indexOf(END, startIdx);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`Markers ${START} and ${END} not found in ${MAIN_JS}`);
  }
  return main.slice(0, startIdx + START.length)
    + '\n' + injected + '\n' + main.slice(endIdx);
}

const main = readFileSync(MAIN_JS, 'utf8');
const next = splice(main, buildInjected());

if (process.argv.includes('--check')) {
  if (next !== main) {
    console.error('main.js is stale relative to core/. Run `npm run build`.');
    process.exit(1);
  }
  console.log('main.js in sync with core/');
  process.exit(0);
}

if (next !== main) {
  writeFileSync(MAIN_JS, next);
  console.log('main.js updated from core/');
} else {
  console.log('main.js already in sync');
}
