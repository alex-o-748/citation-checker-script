import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');

// main.js is a browser userscript IIFE that expects `mw`, so it can't be
// imported directly. Lift generateWikitextReport()/generatePlainTextReport()
// (plus the small helpers they call) out of the source, same approach as
// report_filters.test.js and feedback_controls.test.js.
function classMethod(name) {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const open = `\n        ${name}(`;
  const start = src.indexOf(open);
  assert.ok(start !== -1, `${name}() not found in main.js — did the method get renamed?`);
  const end = src.indexOf('\n        }\n', start);
  assert.ok(end !== -1, `${name}() has no closing brace at class indentation`);
  return src.slice(start + 1, end + '\n        }'.length);
}

function methods() {
  const start = classMethod('generateWikitextReport');
  // generatePlainTextReport ends right before copyReportToClipboard(); its
  // own closing brace isn't followed by the usual blank-line pattern used by
  // classMethod(), so it's captured alongside generateWikitextReport by
  // slicing between the two known markers instead.
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const wikitextStart = src.indexOf('\n        generateWikitextReport() {');
  const plaintextEnd = src.indexOf('\n        async copyReportToClipboard(format) {');
  assert.ok(wikitextStart !== -1 && plaintextEnd !== -1, 'report generators not found in main.js');
  const reportMethods = src.slice(wikitextStart + 1, plaintextEnd);
  return [classMethod('reasonTypeLabel'), classMethod('escapeWikitableCell'), reportMethods].join('\n');
}

function makeHarness(reportUnits, { revId = null } = {}) {
  const mw = { config: { get: key => (key === 'wgTitle' ? 'Test Article' : null) } };
  const Harness = new Function('mw', `
    class Harness {
      constructor(reportUnits) {
        this.reportUnits = reportUnits;
        this.reportRevisionId = ${JSON.stringify(revId)};
        this.reportTokenUsage = { input: 0, output: 0 };
        this.providers = { claude: { name: 'Claude', model: 'claude-sonnet-4-6' } };
        this.currentProvider = 'claude';
      }
      t(en, params) {
        let s = en;
        if (params) for (const k of Object.keys(params)) s = s.split('{' + k + '}').join(String(params[k]));
        return s;
      }
      getReportUnits() { return this.reportUnits; }
      getRevisionPermalinkUrl() { return null; }
${methods()}
    }
    return Harness;
  `)(mw);

  return new Harness(reportUnits);
}

const baseUnit = (overrides) => ({
  citationNumber: 1,
  claimText: 'The bridge opened in 1998.',
  url: 'https://example.com/bridge',
  refElement: null,
  verdict: 'NOT SUPPORTED',
  comments: 'Source says 2002, not 1998.',
  quoteDisplay: '',
  truncated: false,
  ...overrides,
});

test('wikitext report tags a contradiction NOT SUPPORTED row', () => {
  const harness = makeHarness([baseUnit({ reason_type: 'contradiction' })]);
  const wikitext = harness.generateWikitextReport();
  assert.match(wikitext, /Not supported \(Contradiction\)/);
});

test('wikitext report tags an omission NOT SUPPORTED row', () => {
  const harness = makeHarness([baseUnit({ reason_type: 'omission', comments: 'Source never mentions this.' })]);
  const wikitext = harness.generateWikitextReport();
  assert.match(wikitext, /Not supported \(Omission\)/);
});

test('wikitext report leaves other verdicts and reason-type-less rows untagged', () => {
  const harness = makeHarness([
    baseUnit({ verdict: 'SUPPORTED', reason_type: null, comments: 'Matches.' }),
    baseUnit({ citationNumber: 2, reason_type: null }),
  ]);
  const wikitext = harness.generateWikitextReport();
  assert.doesNotMatch(wikitext, /Supported \(/);
  assert.match(wikitext, /\|\s*\{\{cross\}\} Not supported\s*\|\|/);
});

test('plain text report tags a contradiction NOT SUPPORTED row', () => {
  const harness = makeHarness([baseUnit({ reason_type: 'contradiction' })]);
  const text = harness.generatePlainTextReport();
  assert.match(text, /^\[1\] NOT SUPPORTED \(Contradiction\)$/m);
});

test('wikitext report has no Submit column and puts the quote in its own column', () => {
  const harness = makeHarness([baseUnit({
    reason_type: 'contradiction',
    quoteDisplay: 'The bridge opened in August 2002.',
    comments: 'Source says 2002, not 1998.',
  })]);
  const wikitext = harness.generateWikitextReport();
  assert.doesNotMatch(wikitext, /Submit/);
  assert.match(wikitext, /! # !! Verdict !! Source !! Quote !! Comments/);
  // Header has 5 columns, and the data row has 5 cells (four `||` separators).
  const dataRow = wikitext.split('\n').find(line => line.startsWith('| ['));
  assert.ok(dataRow, 'expected a data row starting with the citation cell');
  assert.equal((dataRow.match(/\|\|/g) || []).length, 4);
  assert.match(dataRow, /\|\| ''"The bridge opened in August 2002\."'' \|\|/);
  // The quote text is not duplicated into the comments cell.
  const commentsCell = dataRow.split('||').pop();
  assert.doesNotMatch(commentsCell, /bridge opened in August 2002/);
});

test('wikitext report puts an em dash in the Quote column when there is nothing to quote', () => {
  const harness = makeHarness([baseUnit({ reason_type: 'omission', quoteDisplay: '' })]);
  const wikitext = harness.generateWikitextReport();
  const dataRow = wikitext.split('\n').find(line => line.startsWith('| ['));
  const cells = dataRow.split('||').map(c => c.trim());
  assert.equal(cells[3], '—');
});

test('plain text report tags an omission NOT SUPPORTED row for a combined group', () => {
  const harness = makeHarness([{
    isGroup: true,
    groupCitationNumbers: [1, 2],
    claimText: 'The bridge opened in 1998 and cost $2M.',
    members: [{ citationNumber: 1, url: 'https://a.example' }, { citationNumber: 2, url: 'https://b.example' }],
    verdict: 'NOT SUPPORTED',
    reason_type: 'omission',
    comments: 'Neither source mentions the cost.',
    quoteDisplay: '',
    truncated: false,
  }]);
  const text = harness.generatePlainTextReport();
  assert.match(text, /^\[1\]\[2\] \(combined\) NOT SUPPORTED \(Omission\)$/m);
});
