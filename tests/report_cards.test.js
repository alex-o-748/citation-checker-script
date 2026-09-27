import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { verifyQuote, quoteExpectedFor } from '../core/quote.js';
import { extractSourceText } from '../core/prompts.js';
import { SKIPPED_VERDICT } from '../core/verdicts.js';

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');

// Same approach as quote_ui.test.js: main.js is a browser IIFE that needs
// `mw`, so the report-card methods are lifted out of the source and run
// against jsdom, pinning the assertions to the shipped code.
function extractMethod(src, signature) {
  const start = src.indexOf(`        ${signature}`);
  assert.ok(start !== -1, `method not found in main.js: ${signature}`);
  const end = src.indexOf('\n        }\n', start);
  assert.ok(end !== -1, `end of method not found: ${signature}`);
  return src.slice(start, end + '\n        }\n'.length);
}

function harness() {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const methods = [
    'renderReportCard(result, index) {',
    'reportElementFor(refElement) {',
    'buildSoloCard(result) {',
    'buildGroupBlock(firstResult) {',
    'buildGroupRow(result) {',
    'renderGroupCollectiveResult(result) {',
    'verdictClassFor(verdict) {',
    'reasonTypeLabel(reasonType) {',
    'reasonTypeTagHtml(result) {',
    'escapeHtml(str) {',
    'quoteHtml(view) {',
    'quoteViewOf(result) {',
    'buildQuoteView(parsed, sourceInfo) {',
  ].map((sig) => extractMethod(src, sig)).join('\n');

  const dom = new JSDOM('<!DOCTYPE html><body><div id="verifier-report-results"></div></body>');
  const document = dom.window.document;
  // Only what these methods touch: jsdom lacks CSS.escape, and OOUI buttons
  // are rendered for problem verdicts on citations with a ref element.
  const CSS = { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };
  const OO = { ui: { ButtonWidget: class { constructor() { this.$element = [document.createElement('span')]; } } } };
  const Harness = new Function(
    'document', 'CSS', 'OO', 'verifyQuote', 'extractSourceText', 'quoteExpectedFor', 'SKIPPED_VERDICT', `
    class Harness {
      constructor() { this.reportResults = []; }
      t(en) { return en; }
      attachRefScrollHandler() {}
      buildFeedbackControls() { return null; }
      buildEditUrl() { return '#edit'; }
${methods}
    }
    return Harness;
  `)(document, CSS, OO, verifyQuote, extractSourceText, quoteExpectedFor, SKIPPED_VERDICT);
  return { verifier: new Harness(), document };
}

const INJECTED = '"><img src=x onerror="alert(1)"><span class="';

// --- Model output rendered into report HTML ---
//
// The parser now keeps verdict and reason_type inside their vocabularies
// (tests/parsing.test.js), but the renderer must hold on its own: results can
// reach it from paths other than the parser, and these strings land on
// wikipedia.org with the editor's session and stored API keys in reach.

test('a crafted reason_type or verdict renders as text in every report sink', () => {
  const { verifier, document } = harness();
  const results = document.getElementById('verifier-report-results');
  const base = { claimText: 'A claim.', citationNumber: 1, url: null, refElement: null, comments: '' };

  // Solo card and group row, each with a crafted reason_type and a crafted verdict.
  results.appendChild(verifier.buildSoloCard({ ...base, verdict: 'NOT SUPPORTED', reason_type: `omission${INJECTED}` }));
  results.appendChild(verifier.buildSoloCard({ ...base, verdict: `<img src=x onerror="alert(2)">` }));
  results.appendChild(verifier.buildGroupRow({ ...base, verdict: 'NOT SUPPORTED', reason_type: `omission${INJECTED}` }));
  results.appendChild(verifier.buildGroupRow({ ...base, verdict: `<img src=x onerror="alert(3)">` }));

  // Group collective slot, both fields crafted.
  results.appendChild(verifier.buildGroupBlock({ ...base, groupId: 'g1', groupSize: 2, groupCitationNumbers: [1, 2] }));
  verifier.renderGroupCollectiveResult({ ...base, groupId: 'g1', verdict: 'NOT SUPPORTED', reason_type: `x${INJECTED}` });
  results.appendChild(verifier.buildGroupBlock({ ...base, groupId: 'g2', groupSize: 2, groupCitationNumbers: [3, 4] }));
  verifier.renderGroupCollectiveResult({ ...base, groupId: 'g2', verdict: `<img src=x onerror="alert(4)">` });

  assert.equal(results.querySelectorAll('img').length, 0, 'no injected element in the DOM');
  for (const tag of results.querySelectorAll('.reason-type-tag')) {
    assert.match(tag.className, /^reason-type-tag reason-type-(contradiction|omission)$/);
  }
  assert.ok(results.textContent.includes('<img src=x onerror="alert(2)">'), 'the crafted verdict shows as text');
});

test('escapeHtml is safe inside a double-quoted attribute', () => {
  const { verifier, document } = harness();
  const url = `https://example.com/a${INJECTED}`;
  const holder = document.createElement('div');
  holder.innerHTML = `<a href="${verifier.escapeHtml(url)}" title="${verifier.escapeHtml("it's")}">x</a>`;
  const links = holder.querySelectorAll('a');
  assert.equal(links.length, 1);
  assert.equal(holder.querySelectorAll('img').length, 0);
  assert.equal(links[0].getAttribute('href'), url, 'the attribute round-trips intact');
  assert.equal(links[0].getAttribute('title'), "it's");
});

// --- Clicking an article citation during a report run ---
//
// handleReferenceClick() used to look for `.report-card`, a class no element
// carries, so the click was swallowed (preventDefault) and nothing scrolled.
// Position would not have worked either: group members render as rows inside
// a group block, so the Nth element on screen is not the Nth result.

test('reportElementFor finds the card or group row for a citation, across groups', () => {
  const { verifier, document } = harness();
  const refs = [1, 2, 3, 4].map(() => document.createElement('a'));
  const results = [
    { citationNumber: 1, refElement: refs[0], verdict: 'SUPPORTED' },
    { citationNumber: 2, refElement: refs[1], verdict: 'SUPPORTED', groupId: 'g', groupSize: 2, groupCitationNumbers: [2, 3] },
    { citationNumber: 3, refElement: refs[2], verdict: 'NOT SUPPORTED', groupId: 'g', groupSize: 2, groupCitationNumbers: [2, 3] },
    { citationNumber: 4, refElement: refs[3], verdict: 'PARTIALLY SUPPORTED' },
  ].map((r) => ({ claimText: `Claim ${r.citationNumber}.`, url: null, comments: '', ...r }));

  results.forEach((result, index) => {
    verifier.reportResults.push(result);
    verifier.renderReportCard(result, index);
  });

  const solo = verifier.reportElementFor(refs[3]);
  assert.ok(solo, 'the solo card after a group is found');
  assert.ok(solo.classList.contains('verifier-report-card'));
  assert.match(solo.textContent, /\[4\]/);

  const row = verifier.reportElementFor(refs[2]);
  assert.ok(row, 'a group member is found');
  assert.ok(row.classList.contains('verifier-report-group-row'));
  assert.match(row.textContent, /\[3\]/);

  assert.equal(verifier.reportElementFor(document.createElement('a')), null, 'an unchecked citation finds nothing');
});
