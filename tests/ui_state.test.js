import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');

// main.js is a browser userscript in an IIFE that expects `mw`, so it can't be
// imported. Lift the view-state methods out of the source and run them against
// a jsdom document holding the same element ids createUI() emits.
function harness(state = {}) {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const start = src.indexOf('        renderUiState() {');
  const endMarker = '        // Design tokens.';
  const end = src.indexOf(endMarker);
  assert.ok(start !== -1 && end > start, 'view-state methods not found in main.js');
  const methods = src.slice(start, end);

  const ids = [
    'verifier-settings-view', 'verifier-main-view', 'verifier-report-view',
    'verifier-idle-view', 'verifier-claim-section', 'verifier-source-section',
    'verifier-results', 'verifier-controls', 'verifier-status-dot', 'verifier-status-text'
  ];
  const dom = new JSDOM(`<!DOCTYPE html><body>${ids.map((id) => `<div id="${id}"></div>`).join('')}</body>`);

  const Harness = new Function('document', `
    class Harness {
      constructor(state) { Object.assign(this, state); }
      t(en, params) {
        let s = en;
        if (params) for (const k of Object.keys(params)) s = s.split('{' + k + '}').join(String(params[k]));
        return s;
      }
      getCurrentApiKey() { return this.apiKey || null; }
${methods}
    }
    return Harness;
  `)(dom.window.document);

  const defaults = {
    settingsOpen: false, reportMode: false, hasResult: false,
    activeClaim: null, reportRunning: false, apiKey: null,
    currentProvider: 'free',
    providers: { free: { name: 'Free', model: 'some/model', requiresKey: false } }
  };
  const instance = new Harness({ ...defaults, ...state });
  return { instance, doc: dom.window.document };
}

const visible = (doc, id) => doc.getElementById(id).style.display !== 'none';

test('idle shows the prompt and hides claim, source and result', () => {
  const { instance, doc } = harness();
  instance.renderUiState();

  assert.ok(visible(doc, 'verifier-idle-view'), 'idle prompt should be visible');
  assert.ok(!visible(doc, 'verifier-claim-section'), 'no claim selected, so no claim section');
  assert.ok(!visible(doc, 'verifier-source-section'), 'no claim selected, so no source section');
  assert.ok(!visible(doc, 'verifier-results'), 'nothing verified yet, so no result section');
  assert.ok(visible(doc, 'verifier-controls'), 'the whole-article action stays available');
});

test('selecting a claim replaces the prompt with claim and source', () => {
  const { instance, doc } = harness({ activeClaim: 'The bridge opened in 1932.' });
  instance.renderUiState();

  assert.ok(!visible(doc, 'verifier-idle-view'));
  assert.ok(visible(doc, 'verifier-claim-section'));
  assert.ok(visible(doc, 'verifier-source-section'));
  assert.ok(!visible(doc, 'verifier-results'), 'still nothing verified');
});

test('a finished check shows the result alongside its evidence', () => {
  const { instance, doc } = harness({ activeClaim: 'x', hasResult: true });
  instance.renderUiState();

  assert.ok(visible(doc, 'verifier-results'));
  assert.ok(visible(doc, 'verifier-claim-section'), 'the claim stays on screen as evidence');
  assert.ok(!visible(doc, 'verifier-idle-view'));
});

test('report mode replaces the single-citation view entirely', () => {
  const { instance, doc } = harness({ activeClaim: 'x', hasResult: true, reportMode: true });
  instance.renderUiState();

  assert.ok(visible(doc, 'verifier-report-view'));
  assert.ok(!visible(doc, 'verifier-results'));
  assert.ok(!visible(doc, 'verifier-claim-section'));
  assert.ok(!visible(doc, 'verifier-idle-view'));
});

test('settings takes over the panel and is dismissed by closeSettings', () => {
  const { instance, doc } = harness({ activeClaim: 'x', hasResult: true });

  instance.openSettings();
  assert.ok(visible(doc, 'verifier-settings-view'));
  assert.ok(!visible(doc, 'verifier-main-view'), 'main view is hidden behind settings');

  instance.closeSettings();
  assert.ok(!visible(doc, 'verifier-settings-view'));
  assert.ok(visible(doc, 'verifier-main-view'));
  assert.ok(visible(doc, 'verifier-results'), 'the previous result survives a settings round trip');
});

test('settings wins over report mode so the two views never stack', () => {
  const { instance, doc } = harness({ reportMode: true, settingsOpen: true });
  instance.renderUiState();

  assert.ok(visible(doc, 'verifier-settings-view'));
  assert.ok(!visible(doc, 'verifier-report-view'));
});

// The status strip is the only place the tool reports readiness, so it must
// never name a model — that lives in settings and in the generated wikitext.
test('the status strip reports readiness without naming a model', () => {
  const { instance, doc } = harness();
  instance.renderUiState();

  const text = doc.getElementById('verifier-status-text').textContent;
  assert.match(text, /Ready/);
  assert.ok(!text.includes('some/model'), 'the model name must not leak into the status strip');
  assert.equal(doc.getElementById('verifier-status-dot').className, 'ready');
});

test('a provider missing its key blocks and points at settings', () => {
  const { instance, doc } = harness({
    currentProvider: 'paid',
    providers: { paid: { name: 'Paid', model: 'm', requiresKey: true } }
  });
  instance.renderUiState();

  assert.match(doc.getElementById('verifier-status-text').textContent, /Add an API key/);
  assert.equal(doc.getElementById('verifier-status-dot').className, 'blocked');
});

test('a stored key is reported as such', () => {
  const { instance, doc } = harness({
    apiKey: 'sk-test',
    currentProvider: 'paid',
    providers: { paid: { name: 'Paid', model: 'm', requiresKey: true } }
  });
  instance.renderUiState();
  assert.match(doc.getElementById('verifier-status-text').textContent, /using your API key/);
});

test('every verdict carries a next step, and unknown verdicts stay silent', () => {
  const { instance } = harness();
  for (const verdict of ['SUPPORTED', 'PARTIALLY SUPPORTED', 'NOT SUPPORTED', 'SOURCE UNAVAILABLE']) {
    const step = instance.nextStepFor(verdict);
    assert.ok(step && step.length > 0, `${verdict} should tell the editor what to do next`);
  }
  assert.equal(instance.nextStepFor('PARSE_ERROR'), '', 'no invented advice for an unparseable result');
});
