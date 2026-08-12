import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { verifyQuote, quoteExpectedFor } from '../core/quote.js';
import { extractSourceText } from '../core/prompts.js';

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');

// Same approach as ui_state.test.js: main.js is a browser IIFE that needs `mw`,
// so the methods under test are lifted out of the source and run against jsdom.
// This keeps the assertions pinned to the shipped code rather than a copy.
function extractMethod(src, signature) {
  const start = src.indexOf(`        ${signature}`);
  assert.ok(start !== -1, `method not found in main.js: ${signature}`);
  // Methods are indented 8 spaces; the closing brace sits at that same level.
  const end = src.indexOf('\n        }\n', start);
  assert.ok(end !== -1, `end of method not found: ${signature}`);
  return src.slice(start, end + '\n        }\n'.length);
}

function harness() {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const methods = [
    'buildQuoteView(parsed, sourceInfo) {',
    'quoteViewOf(result) {',
    'quoteHtml(view) {',
    'escapeWikitableCell(str) {',
    'escapeHtml(str) {',
  ].map((sig) => extractMethod(src, sig)).join('\n');

  const dom = new JSDOM('<!DOCTYPE html><body></body>');
  const Harness = new Function('document', 'verifyQuote', 'extractSourceText', 'quoteExpectedFor', `
    class Harness {
      t(en) { return en; }
${methods}
    }
    return Harness;
  `)(dom.window.document, verifyQuote, extractSourceText, quoteExpectedFor);
  return new Harness();
}

const SOURCE_INFO = 'Source URL: https://example.com\n\nSource Content:\n'
  + 'The bridge was finally opened to traffic in August 2002, four years behind schedule.';

test('buildQuoteView verifies a quote against the wrapped source blob', () => {
  const view = harness().buildQuoteView(
    { source_quote: 'opened to traffic in August 2002' },
    SOURCE_INFO
  );
  assert.equal(view.verified, true);
  assert.equal(view.quote, 'opened to traffic in August 2002');
});

test('buildQuoteView rejects a quote the source does not contain', () => {
  const view = harness().buildQuoteView(
    { source_quote: 'The bridge opened in 1998 exactly on schedule.' },
    SOURCE_INFO
  );
  assert.equal(view.verified, false);
  assert.equal(view.status, 'not-found');
});

test('buildQuoteView handles a missing quote and a missing source', () => {
  const h = harness();
  assert.equal(h.buildQuoteView({ source_quote: '' }, SOURCE_INFO).status, 'empty');
  assert.equal(h.buildQuoteView({}, SOURCE_INFO).status, 'empty');
  assert.equal(h.buildQuoteView({ source_quote: 'some long quoted passage' }, null).status, 'no-source');
});

test('quoteHtml renders a verified quote as an evidence block', () => {
  const html = harness().quoteHtml({
    quote: 'opened to traffic in August 2002',
    display: 'opened to traffic in August 2002',
    verified: true,
  });
  assert.match(html, /class="sv-quote"/);
  assert.match(html, /opened to traffic in August 2002/);
});

test('quoteHtml never prints the text of an unverified quote', () => {
  const html = harness().quoteHtml({
    quote: 'A sentence the source never contained',
    display: '',
    verified: false,
    status: 'not-found',
  });
  assert.equal(html, '');
});

test('quoteHtml renders nothing when no quote was offered', () => {
  assert.equal(harness().quoteHtml({ quote: '', verified: false, status: 'empty' }), '');
  assert.equal(harness().quoteHtml(null), '');
});

test('quoteHtml escapes HTML in the quoted passage', () => {
  const html = harness().quoteHtml({
    quote: '<img src=x onerror=alert(1)>',
    display: '<img src=x onerror=alert(1)>',
    verified: true,
  });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('quoteViewOf reuses the verification stored on a report result', () => {
  const h = harness();
  assert.deepEqual(
    h.quoteViewOf({
      sourceQuote: 'a passage', quoteDisplay: 'a passage',
      quoteVerified: true, quoteStatus: 'exact',
    }),
    { quote: 'a passage', display: 'a passage', verified: true, status: 'exact' }
  );
  assert.equal(h.quoteViewOf({ sourceQuote: '' }), null);
  assert.equal(h.quoteViewOf(null), null);
});

test('escapeWikitableCell neutralizes pipes, braces and newlines', () => {
  const out = harness().escapeWikitableCell('a | b {{tl}} c\nd');
  assert.equal(out, 'a &#124; b &#123;&#123;tl&#125;&#125; c d');
});

// The panel says nothing about a quote it could not locate, on any verdict.
// The warning that used to appear here implied the verdict was less accurate,
// which is a claim the benchmark has not been asked yet — see quoteHtml.
test('an unlocatable quote is silent regardless of verdict', () => {
  const h = harness();
  for (const [verdict, reason_type] of [
    ['SUPPORTED', null],
    ['PARTIALLY SUPPORTED', null],
    ['NOT SUPPORTED', 'contradiction'],
    ['NOT SUPPORTED', 'omission'],
    ['SOURCE UNAVAILABLE', null],
  ]) {
    const view = h.buildQuoteView(
      { source_quote: 'a passage the source never contained at all', verdict, reason_type },
      SOURCE_INFO
    );
    assert.equal(view.status, 'not-found');
    assert.equal(h.quoteHtml(view), '', `${verdict}/${reason_type} should render nothing`);
  }
});

test('a verified quote is shown even on a verdict that did not require one', () => {
  const html = harness().quoteHtml({
    quote: 'opened to traffic in August 2002',
    display: 'opened to traffic in August 2002',
    verified: true,
    expected: false,
  });
  assert.match(html, /class="sv-quote"/);
});

// --- partially verified quotes (the PDF line-break case) ---

test('buildQuoteView exposes only the located fragments as display text', () => {
  const source = 'Source Content:\nAlpha the first located fragment here. '
    + 'Gamma the third located fragment here.';
  const view = harness().buildQuoteView(
    { source_quote: 'Alpha the first located fragment here. ... a fragment that is not present at all ... Gamma the third located fragment here.',
      verdict: 'SUPPORTED' },
    source
  );
  assert.equal(view.status, 'partial');
  assert.equal(view.verified, false);
  assert.match(view.display, /Alpha the first located fragment here/);
  assert.match(view.display, /Gamma the third located fragment here/);
  assert.doesNotMatch(view.display, /not present at all/);
});

test('quoteHtml shows the located fragments of a partial match', () => {
  const html = harness().quoteHtml({
    quote: 'real fragment ... invented fragment',
    display: 'real fragment',
    verified: false,
    status: 'partial',
  });
  assert.match(html, /class="sv-quote"/);
  assert.match(html, /real fragment/);
  assert.doesNotMatch(html, /invented fragment/);
});

test('a partial match is presented no differently from a full one', () => {
  // The block makes one promise — this text is in the source — and it holds
  // identically either way. Anything extra would be commentary on the model.
  const h = harness();
  const full = h.quoteHtml({ quote: 'a located passage', display: 'a located passage', verified: true });
  const part = h.quoteHtml({ quote: 'a located passage ... dropped', display: 'a located passage', verified: false, status: 'partial' });
  assert.equal(full, part);
});

test('a quote with nothing located renders nothing at all', () => {
  const html = harness().quoteHtml({
    quote: 'entirely invented', display: '', verified: false, status: 'not-found',
  });
  assert.equal(html, '');
});
