import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractClaimText, MAINTENANCE_MARKER_RE } from '../core/claim.js';

function mkDoc(html) {
  return new JSDOM(`<!DOCTYPE html><body>${html}</body>`).window.document;
}

test('MAINTENANCE_MARKER_RE strips failed-verification marker', () => {
  const input = 'The sky is blue[failed verification] on clear days.';
  assert.equal(
    input.replace(MAINTENANCE_MARKER_RE, ''),
    'The sky is blue on clear days.'
  );
});

test('MAINTENANCE_MARKER_RE strips citation-needed marker', () => {
  const input = 'Paris is the capital[citation needed].';
  assert.equal(
    input.replace(MAINTENANCE_MARKER_RE, ''),
    'Paris is the capital.'
  );
});

test('extractClaimText returns text preceding the cited reference', () => {
  // Build a minimal paragraph with one citation. Exact selectors must match what
  // the function walks for — inspect core/claim.js while writing this fixture and
  // adjust the HTML shape until the test passes.
  const doc = mkDoc(`
    <p>The boiling point of water is 100 degrees Celsius.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup></p>
  `);
  const ref = doc.getElementById('cite_ref-1');
  const claim = extractClaimText(ref);
  assert.ok(claim.includes('boiling point of water is 100 degrees Celsius'));
});

test('extractClaimText strips maintenance markers from the returned claim', () => {
  const doc = mkDoc(`
    <p>Elvis is still alive[failed verification].<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup></p>
  `);
  const ref = doc.getElementById('cite_ref-1');
  const claim = extractClaimText(ref);
  assert.ok(!claim.includes('[failed verification]'), `marker leaked into claim: ${claim}`);
  assert.ok(claim.includes('Elvis is still alive'));
});

test('extractClaimText strips maintenance markers that contain a non-breaking space', () => {
  // Wikipedia's {{failed verification}} and similar templates are styled
  // white-space:nowrap and emit U+00A0 between the words in the rendered
  // bracket text, so range.toString() yields "[failed verification]"
  // rather than "[failed verification]".
  const doc = mkDoc(`
    <p>Elvis is still alive[failed verification].<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup></p>
  `);
  const ref = doc.getElementById('cite_ref-1');
  const claim = extractClaimText(ref);
  assert.ok(!claim.includes('failed') && !claim.includes('verification'),
    `NBSP marker leaked into claim: ${JSON.stringify(claim)}`);
  assert.ok(claim.includes('Elvis is still alive'));
});
