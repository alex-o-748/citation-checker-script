import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');

// main.js is a browser userscript wrapped in an IIFE that expects `mw`, so it
// can't be imported. Instead we lift the three styling methods out of the
// source and run them against a stub `document` to capture the stylesheet the
// userscript would actually inject.
function generateCss(accent = '#6B21A8') {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const start = src.indexOf('        styleTokens(accent) {');
  const endMarker = '            document.head.appendChild(style);\n        }';
  const end = src.indexOf(endMarker);
  assert.ok(start !== -1, 'styleTokens() not found in main.js — did the method get renamed?');
  assert.ok(end !== -1, 'createStyles() tail not found in main.js — did the method get renamed?');
  const methods = src.slice(start, end + endMarker.length);

  let captured = null;
  const documentStub = {
    createElement: () => ({ id: '', set textContent(v) { captured = v; } }),
    getElementById: () => null,
    head: { appendChild() {} }
  };

  const Harness = new Function('document', `
    class Harness {
      constructor() { this.sidebarWidth = '400px'; this.isVisible = true; }
      getCurrentColor() { return ${JSON.stringify(accent)}; }
${methods}
    }
    return Harness;
  `)(documentStub);

  new Harness().createStyles();
  assert.ok(captured, 'createStyles() produced no stylesheet');
  return captured;
}

function tokensIn(css, blockRe) {
  const match = css.match(blockRe);
  assert.ok(match, `token block not found for ${blockRe}`);
  return new Set([...match[1].matchAll(/(--sv-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

const LIGHT_BLOCK = /:root \{([\s\S]*?)\n\s*\}/;
const NIGHT_BLOCK = /html\.skin-theme-clientpref-night \{([\s\S]*?)\n\s*\}/;

test('generated stylesheet is structurally valid', () => {
  const css = generateCss();
  assert.ok(!css.includes('${'), 'stylesheet contains an unresolved template placeholder');

  let depth = 0;
  for (const ch of css) {
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      assert.ok(depth >= 0, 'stylesheet has an unbalanced closing brace');
    }
  }
  assert.equal(depth, 0, 'stylesheet has an unclosed block');
});

// The bug this guards against, documented in CLAUDE.md: a component gets
// light-mode CSS but is never given a dark-mode value, so it stays light-on-light
// for readers on a dark theme. With tokens that can only happen by referencing a
// custom property that was never defined, which is exactly what this asserts.
test('every --sv-* token used is defined in the base :root block', () => {
  const css = generateCss();
  const defined = tokensIn(css, LIGHT_BLOCK);
  const used = new Set([...css.matchAll(/var\((--sv-[a-z0-9-]+)\)/g)].map((m) => m[1]));

  const undefinedTokens = [...used].filter((t) => !defined.has(t));
  assert.deepEqual(
    undefinedTokens, [],
    `these tokens are used but never defined in :root, so they resolve to nothing: ${undefinedTokens.join(', ')}`
  );
});

test('dark tokens all have a light-mode counterpart', () => {
  const css = generateCss();
  const light = tokensIn(css, LIGHT_BLOCK);
  const dark = tokensIn(css, NIGHT_BLOCK);

  const orphans = [...dark].filter((t) => !light.has(t));
  assert.deepEqual(
    orphans, [],
    `these tokens exist only in the dark block, so light mode has no value for them: ${orphans.join(', ')}`
  );
});

test('both dark-mode signals receive the identical token block', () => {
  const css = generateCss();
  const night = tokensIn(css, NIGHT_BLOCK);
  const os = tokensIn(css, /html\.skin-theme-clientpref-os \{([\s\S]*?)\n\s*\}/);

  // Wikipedia's explicit night theme and its "follow the OS" theme are separate
  // signals. Historically they were hand-mirrored and drifted apart; they are
  // now emitted from one source, so they must stay identical.
  assert.deepEqual(
    [...night].sort(), [...os].sort(),
    'the night and OS-dark token blocks have diverged'
  );
});

test('no component rule hardcodes a color outside the token blocks', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const start = src.indexOf('        createStyles() {');
  const end = src.indexOf('            document.head.appendChild(style);', start);
  const body = src.slice(start, end);

  // createStyles() itself should be pure var() references; literal colors belong
  // in styleTokens(), and the handful of dark-only OOUI greys in darkOnlyStyles().
  const offenders = body
    .split('\n')
    .filter((line) => /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z-])/.test(line) && !line.trim().startsWith('//'));

  assert.deepEqual(
    offenders, [],
    `createStyles() should reference tokens, not literal colors:\n${offenders.join('\n')}`
  );
});

test('token values stay in sync with the selected provider accent', () => {
  const css = generateCss('#123456');
  assert.ok(css.includes('--sv-accent: #123456;'), 'accent token does not track getCurrentColor()');
  assert.ok(!css.includes('#6B21A8'), 'a stale accent color is baked into the stylesheet');
});
