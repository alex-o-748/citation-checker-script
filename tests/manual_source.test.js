import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');

// Regression test for a bug where overriding a source (pasting text, or
// uploading a PDF) silently did nothing: loadManualSourceText() referenced
// MAX_MANUAL_SOURCE_CHARS, but a later cleanup deleted the module-level
// `const MAX_MANUAL_SOURCE_CHARS = ...` while leaving the references behind.
// That threw a ReferenceError as soon as any non-empty text was loaded — before
// activeSource was ever updated — and the failure was swallowed by a catch
// block that only console.error()s, so nothing appeared in the UI. The override
// panel (and the freshly-extracted PDF text sitting in its textarea) stayed
// on screen untouched, looking exactly like the upload had been ignored.
//
// main.js is a browser userscript in an IIFE that expects `mw`/`OO.ui`, so it
// can't be imported directly. Lift the module-level constant and the class
// methods under test out of the source and run them against a jsdom document
// holding the same element ids createUI() emits (same technique as
// ui_state.test.js).
function harness(state = {}) {
  const src = fs.readFileSync(MAIN_JS, 'utf8');

  const constMatch = src.match(/const MAX_MANUAL_SOURCE_CHARS = \d+;/);
  assert.ok(constMatch, 'MAX_MANUAL_SOURCE_CHARS must be defined at module scope in main.js');

  const slice = (startMarker, endMarker) => {
    const start = src.indexOf(startMarker);
    const end = src.indexOf(endMarker, start);
    assert.ok(start !== -1 && end > start, `could not locate ${JSON.stringify(startMarker)}..${JSON.stringify(endMarker)} in main.js`);
    return src.slice(start, end);
  };

  const loadManualSourceText = slice('        loadManualSourceText() {', '        cancelManualSourceText() {');
  const clearResult = slice('        clearResult() {', '        renderClaimGroupIndicator(refElement) {');

  const ids = [
    'verifier-source-text', 'verifier-verdict', 'verifier-comments', 'verifier-verdict-next',
    'verifier-action-container', 'verifier-claim-group-indicator',
  ];
  const dom = new JSDOM(`<!DOCTYPE html><body>${ids.map((id) => `<div id="${id}"></div>`).join('')}</body>`);

  const Harness = new Function('document', `
    ${constMatch[0]}
    class Harness {
      constructor(state) {
        Object.assign(this, state);
        this.statusLog = [];
      }
      t(en) { return en; }
      updateStatus(message, isError = false) { this.statusLog.push({ message, isError }); }
      // Stubbed: exercised by other tests, irrelevant to the
      // MAX_MANUAL_SOURCE_CHARS / stale-result regression under test here.
      hideSourceTextInput() {}
      updateButtonVisibility() {}
      renderUiState() {}
${loadManualSourceText}
${clearResult}
    }
    return Harness;
  `)(dom.window.document);

  const defaults = { hasResult: false, activeSource: null };
  const instance = new Harness({ ...defaults, ...state });
  return { instance, doc: dom.window.document, maxChars: Number(constMatch[0].match(/\d+/)[0]) };
}

test('loading manual source text does not throw ReferenceError', () => {
  const { instance } = harness();
  instance.sourceTextInput = { getValue: () => 'The measured extinction rate was 100 to 1,000 times the background rate.' };

  assert.doesNotThrow(() => instance.loadManualSourceText());
});

test('loading manual source text sets activeSource to the new text', () => {
  const { instance, doc } = harness();
  instance.sourceTextInput = { getValue: () => 'Real extracted PDF content about extinction rates.' };

  instance.loadManualSourceText();

  assert.match(instance.activeSource, /Real extracted PDF content about extinction rates\./);
  assert.match(doc.getElementById('verifier-source-text').innerHTML, /Manual Source Text/);
});

test('an overlong paste is trimmed to MAX_MANUAL_SOURCE_CHARS', () => {
  const { instance, maxChars } = harness();
  const longText = 'x'.repeat(maxChars + 500);
  instance.sourceTextInput = { getValue: () => longText };

  instance.loadManualSourceText();

  const loaded = instance.activeSource.replace('Manual source text:\n\n', '');
  assert.equal(loaded.length, maxChars);
});

test('overriding the source clears a stale verdict from a previous fetch', () => {
  const { instance, doc } = harness({ hasResult: true });
  doc.getElementById('verifier-verdict').textContent = 'SOURCE UNAVAILABLE';
  doc.getElementById('verifier-comments').textContent = 'Only a JavaScript-disabled notice, no article content.';
  instance.sourceTextInput = { getValue: () => 'The real article text extracted from the uploaded PDF.' };

  instance.loadManualSourceText();

  assert.equal(instance.hasResult, false, 'the stale verdict must not survive a source override');
  assert.equal(doc.getElementById('verifier-verdict').textContent, '');
  assert.equal(doc.getElementById('verifier-comments').textContent, '');
});
