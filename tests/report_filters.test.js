import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');

// main.js is a browser userscript in an IIFE that expects `mw`, so it can't be
// imported. Lift applyReportFilters() out of the source and run it against a
// jsdom document holding the markup renderGroupBlock()/renderReportCard() emit.
function harness(bodyHtml, reportFilters) {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const start = src.indexOf('        applyReportFilters() {');
  const endMarker = '        renderReportSummary() {';
  const end = src.indexOf(endMarker);
  assert.ok(start !== -1 && end > start, 'applyReportFilters() not found in main.js');
  const method = src.slice(start, end);

  const dom = new JSDOM(`<!DOCTYPE html><body><div id="verifier-report-results">${bodyHtml}</div></body>`);
  const Harness = new Function('document', `
    class Harness {
      constructor(reportFilters) { this.reportFilters = reportFilters; }
      t(en) { return en; }
${method}
    }
    return Harness;
  `)(dom.window.document);

  const instance = new Harness(reportFilters);
  instance.applyReportFilters();
  return dom.window.document;
}

const soloCard = (cls) => `<div class="verifier-report-card verdict-${cls}"></div>`;
const groupRow = (cls) => `<div class="verifier-report-group-row verdict-${cls}"></div>`;

function groupBlock({ id, collectiveVerdict, skipped, rows }) {
  const attrs = [
    `data-group-id="${id}"`,
    collectiveVerdict ? `data-collective-verdict="${collectiveVerdict}"` : '',
    skipped ? 'data-collective-skipped="true"' : ''
  ].filter(Boolean).join(' ');
  return `<div class="verifier-report-group" ${attrs}>
    <div class="verifier-report-group-rows">${rows.map(groupRow).join('')}</div>
  </div>`;
}

const HIDE_ALL_BUT_NOT_SUPPORTED = {
  supported: true, partial: true, 'not-supported': false, unavailable: true, error: true
};

const isHidden = (doc, id) =>
  doc.querySelector(`.verifier-report-group[data-group-id="${id}"]`).style.display === 'none';

test('a group is filtered by its collective verdict', () => {
  const doc = harness(
    groupBlock({ id: 'g1', collectiveVerdict: 'partial', rows: ['partial', 'supported'] })
      + groupBlock({ id: 'g2', collectiveVerdict: 'not-supported', rows: ['partial'] }),
    HIDE_ALL_BUT_NOT_SUPPORTED
  );
  assert.equal(isHidden(doc, 'g1'), true, 'collective "partial" is filtered off');
  assert.equal(isHidden(doc, 'g2'), false, 'collective "not supported" is shown');
});

test('a group whose collective check is still pending stays visible', () => {
  // Pending groups contribute nothing to getReportUnits(), so the pills do not
  // count them and there is nothing for the summary to disagree with.
  const doc = harness(
    groupBlock({ id: 'g1', rows: ['partial', 'unavailable'] }),
    HIDE_ALL_BUT_NOT_SUPPORTED
  );
  assert.equal(isHidden(doc, 'g1'), false);
});

// Regression: verifyGroupCollective() skips the combined check when at most one
// source was retrievable. getReportUnits() then counts each member as its own
// unit, so the pills report them as hidden — but the block itself carried no
// collective verdict and so ignored the filters entirely, leaving citations on
// screen that the summary had already counted as hidden.
test('a group whose collective check was skipped is filtered by its members', () => {
  const doc = harness(
    // Exactly the case in the report: [5] unavailable (HTTP 401), [6] partial,
    // so only one source was readable and the collective check was skipped.
    groupBlock({ id: 'g1', skipped: true, rows: ['unavailable', 'partial'] })
      + groupBlock({ id: 'g2', skipped: true, rows: ['unavailable', 'not-supported'] }),
    HIDE_ALL_BUT_NOT_SUPPORTED
  );
  assert.equal(isHidden(doc, 'g1'), true, 'every member filtered off ⇒ the block hides');
  assert.equal(isHidden(doc, 'g2'), false, 'one member still shown ⇒ the block stays');
});

test('a skipped group with no rows yet stays visible', () => {
  const doc = harness(
    groupBlock({ id: 'g1', skipped: true, rows: [] }),
    HIDE_ALL_BUT_NOT_SUPPORTED
  );
  assert.equal(isHidden(doc, 'g1'), false);
});

test('solo cards are filtered by CSS classes on the container', () => {
  const doc = harness(soloCard('supported') + soloCard('not-supported'), HIDE_ALL_BUT_NOT_SUPPORTED);
  const results = doc.getElementById('verifier-report-results');
  assert.equal(results.classList.contains('filter-hide-supported'), true);
  assert.equal(results.classList.contains('filter-hide-not-supported'), false);
});

test('the empty-state hint appears only when nothing is left visible', () => {
  const allHidden = harness(
    soloCard('supported') + groupBlock({ id: 'g1', skipped: true, rows: ['partial'] }),
    HIDE_ALL_BUT_NOT_SUPPORTED
  );
  assert.ok(allHidden.querySelector('.verifier-filter-empty'), 'hint should be shown');

  const someVisible = harness(
    soloCard('not-supported') + groupBlock({ id: 'g1', skipped: true, rows: ['partial'] }),
    HIDE_ALL_BUT_NOT_SUPPORTED
  );
  assert.equal(someVisible.querySelector('.verifier-filter-empty'), null, 'hint should not be shown');
});
