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
    'severitySubclaimsHtml(severity) {',
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

// The card anatomy findingHtml() builds: a head line, then details.
const head = '<div class="sv-finding-head"><div class="sv-finding-headline"><span class="sv-finding-verdict"><span class="sv-verdict">Partial</span></span></div></div>';
const card = (id, order) => `<div class="verifier-report-card sv-finding" data-id="${id}" data-doc-order="${order}">${head}`
  + '<div class="sv-finding-details" hidden><div class="sv-quote"></div><div class="sv-finding-actions"><div class="verifier-feedback"></div></div></div></div>';
const group = (id, order, rows) => `<div class="verifier-report-group sv-finding" data-id="${id}" data-doc-order="${order}">${head}`
  + '<div class="sv-finding-details"><div class="verifier-report-group-collective"></div><div class="sv-finding-actions"></div><div class="verifier-report-group-rows">'
  + rows.map((r) => `<div class="verifier-report-group-row sv-finding" data-id="${r}">${head}<div class="sv-finding-details"><div class="sv-finding-actions"></div></div></div>`).join('')
  + '</div></div></div>';
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

test('on a card, what was found goes in the head line and the failing subclaims in the details, above the actions', () => {
  const { h, doc } = harness(card('a', 0));
  const unit = rank(h, doc, 'a', SEVERITY_TIERS.CENTRAL_CONTRADICTED, 20, [{ text: 'opened in 1998', status: 'contradicted', central: true }]);
  h.renderReportSeverity(unit);
  const el = doc.querySelector('[data-id="a"]');
  const tags = [...el.querySelector(':scope > .sv-finding-head').querySelectorAll('.sv-severity-tag')];
  assert.deepEqual(tags.map((t) => t.textContent), ['Key fact contradicted'], 'replaced, not stacked, on re-render');
  assert.ok(tags[0].classList.contains('sv-finding-tag'), 'a few quiet words, like the reason beside it');
  assert.equal(tags[0].dataset.level, 'high', 'the level is kept, though no longer a colour');
  assert.deepEqual([...el.querySelector('.sv-finding-details').children].map((c) => c.className), ['sv-quote', 'sv-severity-slot', 'sv-finding-actions']);
  assert.match(el.querySelector('.sv-severity-slot').textContent, /Contradicted opened in 1998/);
});

test('a group\'s combined verdict is ranked on the group card, with its subclaims beside the combined evidence', () => {
  const { h, doc } = harness(group('g', 0, ['g1']));
  const slot = doc.querySelector('[data-id="g"] .verifier-report-group-collective');
  const unit = { support_score: 20, severity: { tier: SEVERITY_TIERS.CENTRAL_ABSENT, subclaims: [{ text: 'cost $1m', status: 'absent', central: true }] } };
  h.reportCardEls.set(unit, slot);
  h.renderReportSeverity(unit);
  const groupEl = doc.querySelector('[data-id="g"]');
  assert.equal(groupEl.querySelector(':scope > .sv-finding-head .sv-severity-tag').textContent, 'Key fact not in source');
  assert.match(slot.querySelector('.sv-severity-slot').textContent, /Not in source cost \$1m/);
  assert.equal(doc.querySelector('[data-id="g1"] .sv-severity-tag'), null, 'not on its sources');
  assert.equal(groupEl.dataset.severityTier, 'T2');
});

test('an unranked card says so in its head, with the error as a tooltip rather than text', () => {
  const { h, doc } = harness(card('a', 0));
  rank(h, doc, 'a', null);
  const tag = doc.querySelector('[data-id="a"] .sv-severity-tag');
  assert.equal(tag.textContent, 'Not ranked');
  assert.equal(tag.title, 'parse_error');
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
  assert.match(html, /<li class="sv-subclaim sv-subclaim-absent">.*<span class="sv-subclaim-text">Holt is an engineer <span class="sv-subclaim-minor">\(minor\)<\/span><\/span><\/li>/);
});

test('badge labels say what was found; T2 tells a contradicted detail from a missing key fact', () => {
  const { h } = harness();
  const label = (tier, subclaims) => h.severityLabelFor({ tier, subclaims }).label;
  assert.equal(label('T2', [{ status: 'contradicted', central: false }, { status: 'supported', central: true }]), 'Detail contradicted');
  assert.equal(label('T2', [{ status: 'absent', central: true }]), 'Key fact not in source');
  assert.equal(label('T3', []), 'Only a minor detail missing');
  assert.equal(label('discounted', null), 'Unclear: source only partly read');
  assert.equal(h.severityLabelFor({ tier: 'discounted', subclaims: null, unreadSources: true }).label, 'Unclear: not every cited source was read');
  assert.equal(label('disagreement', []), 'Second check found it supported');
  assert.equal(label(null, null), 'Not ranked');
  assert.match(h.severityHtml({ tier: null, subclaims: null, error: 'parse_error' }), /title="parse_error"/);
});
