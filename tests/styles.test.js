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

function tokenValues(css, blockRe) {
  const match = css.match(blockRe);
  assert.ok(match, `token block not found for ${blockRe}`);
  const values = {};
  for (const m of match[1].matchAll(/(--sv-[a-z0-9-]+)\s*:\s*([^;]+);/g)) values[m[1]] = m[2].trim();
  return values;
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

// Keeps the token set honest: a token left behind after the component that
// used it was removed is dead weight that later readers have to reason about.
test('no token is defined but never used', () => {
  const css = generateCss();
  const defined = tokensIn(css, LIGHT_BLOCK);
  const used = new Set([...css.matchAll(/var\((--sv-[a-z0-9-]+)\)/g)].map((m) => m[1]));

  const unused = [...defined].filter((t) => !used.has(t));
  assert.deepEqual(unused, [], `these tokens are defined but referenced nowhere: ${unused.join(', ')}`);
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

// Relative luminance and contrast ratio per WCAG 2.x.
function contrast(hexA, hexB) {
  const lum = (hex) => {
    const n = hex.replace('#', '');
    const channels = [0, 2, 4]
      .map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const [hi, lo] = [lum(hexA), lum(hexB)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

// --sv-accent is a background that always sits under white text (the sidebar
// header, the active reference marker). --sv-accent-fg is the same hue used as a
// mark ON the panel, so it lightens in dark mode. Swapping the two makes the
// header pale lavender with unreadable white text, which is exactly what
// happened when a single token tried to serve both roles.
test('the accent stays legible under white text in both themes', () => {
  const css = generateCss();
  const light = tokensIn(css, LIGHT_BLOCK);
  const dark = tokensIn(css, NIGHT_BLOCK);

  assert.ok(light.has('--sv-accent'), '--sv-accent must have a base value');
  assert.ok(
    !dark.has('--sv-accent'),
    '--sv-accent carries white text, so dark mode must not redefine it — lighten --sv-accent-fg instead'
  );

  const value = css.match(/--sv-accent:\s*(#[0-9a-fA-F]{6})/);
  assert.ok(value, '--sv-accent should resolve to a hex color');
  const ratio = contrast(value[1], '#ffffff');
  assert.ok(
    ratio >= 4.5,
    `white text on --sv-accent (${value[1]}) is ${ratio.toFixed(2)}:1, below the 4.5:1 WCAG AA floor`
  );
});

test('the accent mark is legible against the dark panel background', () => {
  const css = generateCss();
  const dark = tokenValues(css, NIGHT_BLOCK);
  const fg = dark['--sv-accent-fg'];
  const bg = dark['--sv-bg'];
  assert.ok(fg && bg, 'the dark block should define both --sv-accent-fg and --sv-bg');

  const ratio = contrast(fg, bg);
  assert.ok(
    ratio >= 4.5,
    `the dark accent mark (${fg}) is ${ratio.toFixed(2)}:1 against the panel (${bg}), below 4.5:1`
  );
});

// A frameless OOUI button is chrome-less on purpose — the header gear and
// close, the "paste source text manually" link. An unscoped dark-mode
// background override turns each of them into a filled box.
test('the dark-mode button background only targets framed buttons', () => {
  const css = generateCss();
  const rules = css.match(/[^{}]*\.oo-ui-buttonElement-button \{[^}]*background:[^}]*\}/g) || [];
  const unscoped = rules.filter((rule) => {
    const selector = rule.slice(0, rule.indexOf('{'));
    if (!selector.includes('skin-theme-clientpref')) return false;
    // Flagged (primary/destructive) rules and the header's own overrides are
    // intentionally specific; the broad catch-all is the one that must be framed.
    if (selector.includes('oo-ui-flaggedElement') || selector.includes('verifier-sidebar-header')) return false;
    return !selector.includes('oo-ui-buttonElement-framed');
  });
  assert.deepEqual(
    unscoped, [],
    `these rules paint a background on every button, frameless ones included:\n${unscoped.join('\n')}`
  );
});

test('token values stay in sync with the selected provider accent', () => {
  const css = generateCss('#123456');
  assert.ok(css.includes('--sv-accent: #123456;'), 'accent token does not track getCurrentColor()');
  assert.ok(!css.includes('#6B21A8'), 'a stale accent color is baked into the stylesheet');
});
