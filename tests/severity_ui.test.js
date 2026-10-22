import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { SUBCLAIM_STATUSES, SEVERITY_TIERS, compareSeverity } from '../core/severity.js';

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');

// Same approach as quote_ui.test.js: main.js is a browser IIFE that needs `mw`,
// so the severity rendering and report-sorting methods are lifted out of the
// source and run against jsdom, pinning the shipped code rather than a copy.
function extractMethod(src, signature) {
  const start = src.indexOf(`        ${signature}`);
  assert.ok(start !== -1, `method not found in main.js: ${signature}`);
  const end = src.indexOf('\n        }\n', start);
  assert.ok(end !== -1, `end of method not found: ${signature}`);
  return src.slice(start, end + '\n        }\n'.length);
}

function harness(bodyHtml = '') {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const methods = [
    'severityLabelFor(severity) {',
    'severityHtml(severity) {',
    'renderReportSeverity(unit) {',
    'blockSeverity(block) {',
    'applyReportSort() {',
    'escapeHtml(str) {',
  ].map((sig) => extractMethod(src, sig)).join('\n');

  const dom = new JSDOM(`<!DOCTYPE html><body><div id="verifier-report-results">${bodyHtml}</div></body>`);
  const Harness = new Function('document', 'SUBCLAIM_STATUSES', 'SEVERITY_TIERS', 'compareSeverity', `
    class Harness {
      constructor() { this.reportCardEls = new Map(); this.reportSeverity = true; this.reportSort = 'severity'; }
      t(en) { return en; }
${methods}
    }
    return Harness;
  `)(dom.window.document, SUBCLAIM_STATUSES, SEVERITY_TIERS, compareSeverity);
  return { h: new Harness(), doc: dom.window.document };
}

const card = (id, order) => `<div class="verifier-report-card" data-id="${id}" data-doc-order="${order}"><div class="report-card-comment"></div><div class="verifier-feedback"></div></div>`;
const group = (id, order, rows) => `<div class="verifier-report-group" data-id="${id}" data-doc-order="${order}"><div class="verifier-report-group-rows">${
  rows.map((r) => `<div class="verifier-report-group-row" data-id="${r}"></div>`).join('')}</div></div>`;
const order = (doc) => [...doc.getElementById('verifier-report-results').children].map((el) => el.dataset.id || el.className);

// Ranks the element with data-id=`id` the way rankReportBySeverity() does.
function rank(h, doc, id, tier, supportScore = 20, subclaims = null) {
  const unit = { support_score: supportScore, severity: { tier, subclaims, error: tier ? null : 'parse_error' } };
  h.reportCardEls.set(unit, doc.querySelector(`[data-id="${id}"]`));
  h.renderReportSeverity(unit);
  return unit;
}

test('"Most serious first" orders by tier, unranked blocks keep article order after the ranked ones', () => {
  const { h, doc } = harness(card('a', 0) + card('b', 1) + card('c', 2) + card('d', 3) + card('e', 4));
  rank(h, doc, 'b', SEVERITY_TIERS.PERIPHERAL_ABSENT);
  rank(h, doc, 'd', SEVERITY_TIERS.CENTRAL_CONTRADICTED);
  rank(h, doc, 'e', SEVERITY_TIERS.CENTRAL_ABSENT);
  rank(h, doc, 'c', null); // pass failed: badge says "Not ranked", sorts with the unranked
  h.applyReportSort();
  assert.deepEqual(order(doc), ['d', 'e', 'b', 'a', 'c']);

  h.reportSort = 'document';
  h.applyReportSort();
  assert.deepEqual(order(doc), ['a', 'b', 'c', 'd', 'e'], 'article order is restored exactly');
});

test('within a tier, the lower first-pass support score comes first, then article order', () => {
  const { h, doc } = harness(card('a', 0) + card('b', 1) + card('c', 2));
  rank(h, doc, 'a', SEVERITY_TIERS.CENTRAL_ABSENT, 40);
  rank(h, doc, 'b', SEVERITY_TIERS.CENTRAL_ABSENT, 10);
  rank(h, doc, 'c', SEVERITY_TIERS.CENTRAL_ABSENT, 40);
  h.applyReportSort();
  assert.deepEqual(order(doc), ['b', 'a', 'c']);
});

test('sorting moves whole group blocks, ranks a skipped group by its worst member, and never hides anything', () => {
  const { h, doc } = harness(card('a', 0) + group('g', 1, ['g1', 'g2']) + card('b', 2)
    + '<div class="verifier-filter-empty"></div>');
  rank(h, doc, 'a', SEVERITY_TIERS.CENTRAL_ABSENT);
  rank(h, doc, 'g1', SEVERITY_TIERS.PERIPHERAL_ABSENT);
  rank(h, doc, 'g2', SEVERITY_TIERS.CENTRAL_CONTRADICTED);
  rank(h, doc, 'b', SEVERITY_TIERS.PERIPHERAL_ABSENT);
  assert.equal(doc.querySelector('[data-id="g"]').dataset.severityTier, 'T1');
  h.applyReportSort();
  assert.deepEqual(order(doc), ['g', 'a', 'b', 'verifier-filter-empty'], 'the empty-state hint stays last');
  assert.deepEqual([...doc.querySelectorAll('[data-id="g"] .verifier-report-group-row')].map((r) => r.dataset.id), ['g1', 'g2']);
  for (const el of doc.querySelectorAll('[data-doc-order]')) assert.notEqual(el.style.display, 'none');
});

test('a report that was not severity-ranked always shows article order', () => {
  const { h, doc } = harness(card('a', 0) + card('b', 1));
  rank(h, doc, 'b', SEVERITY_TIERS.CENTRAL_CONTRADICTED);
  h.reportSeverity = false;
  h.applyReportSort();
  assert.deepEqual(order(doc), ['a', 'b']);
});

test('the severity block sits above the feedback controls and is replaced, not stacked, on re-render', () => {
  const { h, doc } = harness(card('a', 0));
  const unit = rank(h, doc, 'a', SEVERITY_TIERS.CENTRAL_ABSENT);
  h.renderReportSeverity(unit);
  const children = [...doc.querySelector('[data-id="a"]').children].map((el) => el.className);
  assert.deepEqual(children, ['report-card-comment', 'sv-severity-slot', 'verifier-feedback']);
});

test('the block lists only failing subclaims, marks peripheral ones, and escapes model text', () => {
  const { h } = harness();
  const html = h.severityHtml({
    tier: SEVERITY_TIERS.CENTRAL_CONTRADICTED,
    subclaims: [
      { text: 'opened in <b>1998</b>', status: 'contradicted', central: true },
      { text: 'designed by Holt', status: 'supported', central: true },
      { text: 'Holt is an engineer', status: 'absent', central: false },
    ],
  });
  assert.match(html, /Key fact contradicted/);
  assert.match(html, /opened in &lt;b&gt;1998&lt;\/b&gt;/);
  assert.doesNotMatch(html, /designed by Holt/);
  assert.match(html, /<li class="sv-subclaim sv-subclaim-absent">.*Holt is an engineer <span class="sv-subclaim-minor">\(minor\)<\/span><\/li>/);
});

test('badge labels say what was found; T2 tells a contradicted detail from a missing key fact', () => {
  const { h } = harness();
  const label = (tier, subclaims) => h.severityLabelFor({ tier, subclaims }).label;
  assert.equal(label('T2', [{ status: 'contradicted', central: false }, { status: 'supported', central: true }]), 'Detail contradicted');
  assert.equal(label('T2', [{ status: 'absent', central: true }]), 'Key fact not in source');
  assert.equal(label('T3', []), 'Only a minor detail missing');
  assert.equal(label('discounted', null), 'Unclear: source only partly read');
  assert.equal(label('disagreement', []), 'Second check found it supported');
  assert.equal(label(null, null), 'Not ranked');
  assert.match(h.severityHtml({ tier: null, subclaims: null, error: 'parse_error' }), /title="parse_error"/);
});
