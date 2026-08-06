import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');

// An OOUI icon whose module was never loaded fails silently: the widget still
// renders the icon span and still reserves its width, so the button keeps a
// blank gap where the glyph should be. Worse, it looks fine whenever some other
// gadget on the page happens to have pulled the module in, so the bug appears
// and disappears by article. That is how `edit` shipped unloaded — the pencil
// showed up next to "Edit Section" on pages with VisualEditor and nowhere else.
//
// Which module defines which icon is OOUI's business, not something this repo
// can derive: oojs-ui is not a dependency here. So the mapping is written down,
// and an icon that isn't in it fails the test until someone looks it up and
// adds the module to OOUI_MODULES alongside it.
const ICON_MODULES = {
  arrowPrevious: 'oojs-ui.styles.icons-movement',
  articles: 'oojs-ui.styles.icons-content',
  cancel: 'oojs-ui.styles.icons-interactions',
  check: 'oojs-ui.styles.icons-interactions',
  close: 'oojs-ui.styles.icons-interactions',
  copy: 'oojs-ui.styles.icons-editing-advanced',
  edit: 'oojs-ui.styles.icons-editing-core',
  feedback: 'oojs-ui.styles.icons-interactions',
  settings: 'oojs-ui.styles.icons-interactions',
  trash: 'oojs-ui.styles.icons-moderation',
};

function source() {
  return fs.readFileSync(MAIN_JS, 'utf8');
}

function iconsUsed(src) {
  return new Set([...src.matchAll(/\bicon:\s*'([a-zA-Z]+)'/g)].map((m) => m[1]));
}

function modulesLoaded(src) {
  const block = src.match(/const OOUI_MODULES = \[([\s\S]*?)\];/);
  assert.ok(block, 'OOUI_MODULES not found in main.js — did the constant get renamed?');
  return new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

test('every icon the script names has its module in ICON_MODULES', () => {
  const unmapped = [...iconsUsed(source())].filter((icon) => !ICON_MODULES[icon]);
  assert.deepEqual(
    unmapped, [],
    `these icons are used but not mapped to a module — look up which oojs-ui.styles.icons-* ` +
    `module defines them, add them here, and add that module to OOUI_MODULES: ${unmapped.join(', ')}`
  );
});

test('every module an icon needs is actually loaded', () => {
  const src = source();
  const loaded = modulesLoaded(src);

  const missing = [...iconsUsed(src)]
    .filter((icon) => ICON_MODULES[icon] && !loaded.has(ICON_MODULES[icon]))
    .map((icon) => `${icon} (needs ${ICON_MODULES[icon]})`);

  assert.deepEqual(
    missing, [],
    `these icons will render as blank gaps because their module is not in OOUI_MODULES:\n${missing.join('\n')}`
  );
});

// Loading a module nothing needs is dead payload on every article view.
test('no icon module is loaded that no icon needs', () => {
  const src = source();
  const needed = new Set([...iconsUsed(src)].map((icon) => ICON_MODULES[icon]).filter(Boolean));

  const unused = [...modulesLoaded(src)]
    .filter((mod) => mod.startsWith('oojs-ui.styles.icons-'))
    .filter((mod) => !needed.has(mod));

  assert.deepEqual(unused, [], `these icon modules are loaded but nothing uses them: ${unused.join(', ')}`);
});

// Both entry points build the same widgets, so both need the same modules.
test('both loader call sites use the shared module list', () => {
  const src = source();
  const calls = [...src.matchAll(/mw\.loader\.using\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(calls.length >= 2, `expected at least two mw.loader.using() calls, found ${calls.length}`);

  const hardcoded = calls.filter((args) => !args.includes('OOUI_MODULES'));
  assert.deepEqual(
    hardcoded, [],
    `these calls list modules inline instead of using OOUI_MODULES, so they will drift:\n${hardcoded.join('\n')}`
  );
});
