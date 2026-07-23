import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractClaimText, getCitationGroup, extractSectionTitle, extractClaimContext, claimNeedsDisambiguation, cleanProse, MAINTENANCE_MARKER_RE } from '../core/claim.js';

function mkDoc(html) {
  return new JSDOM(`<!DOCTYPE html><body>${html}</body>`).window.document;
}

function refIds(group) {
  return group.map(el => el.id);
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

test('extractClaimText collapses whitespace left behind after stripping a marker', () => {
  // Real Wikipedia markup often has a space on both sides of an inline
  // maintenance template (e.g. "claim text [failed verification] more text"),
  // so removing the marker leaves a double space in the middle of the claim
  // unless the cleanup chain re-collapses whitespace afterward.
  const doc = mkDoc(`
    <p>Elvis is still alive [failed verification] in Memphis.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup></p>
  `);
  const ref = doc.getElementById('cite_ref-1');
  const claim = extractClaimText(ref);
  assert.ok(!/\s{2,}/.test(claim), `claim contains run of whitespace: ${JSON.stringify(claim)}`);
  assert.ok(claim.includes('Elvis is still alive in Memphis'));
});

test('extractClaimText returns the same claim for every citation in a [1][2][3] run', () => {
  // Adjacent citations with no separating text all attach to the same claim.
  const doc = mkDoc(`
    <p>The boiling point of water is 100 degrees Celsius.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup><sup id="cite_ref-2" class="reference"><a href="#cite_note-2">[2]</a></sup><sup id="cite_ref-3" class="reference"><a href="#cite_note-3">[3]</a></sup></p>
  `);
  const claim1 = extractClaimText(doc.getElementById('cite_ref-1'));
  const claim2 = extractClaimText(doc.getElementById('cite_ref-2'));
  const claim3 = extractClaimText(doc.getElementById('cite_ref-3'));
  assert.equal(claim1, claim2);
  assert.equal(claim2, claim3);
  assert.ok(claim1.includes('boiling point of water is 100 degrees Celsius'));
});

test('getCitationGroup returns all three refs for a [1][2][3] run regardless of which is passed', () => {
  const doc = mkDoc(`
    <p>The boiling point of water is 100 degrees Celsius.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup><sup id="cite_ref-2" class="reference"><a href="#cite_note-2">[2]</a></sup><sup id="cite_ref-3" class="reference"><a href="#cite_note-3">[3]</a></sup></p>
  `);
  for (const id of ['cite_ref-1', 'cite_ref-2', 'cite_ref-3']) {
    const group = getCitationGroup(doc.getElementById(id));
    assert.deepEqual(refIds(group), ['cite_ref-1', 'cite_ref-2', 'cite_ref-3'],
      `wrong group when starting from ${id}`);
  }
});

test('getCitationGroup returns a single-element array for an isolated citation', () => {
  const doc = mkDoc(`
    <p>Paris is the capital of France.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup> It is on the Seine.<sup id="cite_ref-2" class="reference"><a href="#cite_note-2">[2]</a></sup></p>
  `);
  assert.deepEqual(refIds(getCitationGroup(doc.getElementById('cite_ref-1'))), ['cite_ref-1']);
  assert.deepEqual(refIds(getCitationGroup(doc.getElementById('cite_ref-2'))), ['cite_ref-2']);
});

test('getCitationGroup ignores whitespace between adjacent references', () => {
  // Editors sometimes leave a space between adjacent <sup> tags in the source;
  // the rendered text node is whitespace-only and should not split the group.
  const doc = mkDoc(`
    <p>Some claim.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup> <sup id="cite_ref-2" class="reference"><a href="#cite_note-2">[2]</a></sup></p>
  `);
  assert.deepEqual(refIds(getCitationGroup(doc.getElementById('cite_ref-1'))), ['cite_ref-1', 'cite_ref-2']);
});

test('getCitationGroup splits when punctuation appears between citations', () => {
  // A comma between adjacent citations is non-whitespace text and breaks the
  // group. Each citation forms its own group of one.
  const doc = mkDoc(`
    <p>Some claim.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup>, <sup id="cite_ref-2" class="reference"><a href="#cite_note-2">[2]</a></sup></p>
  `);
  assert.deepEqual(refIds(getCitationGroup(doc.getElementById('cite_ref-1'))), ['cite_ref-1']);
  assert.deepEqual(refIds(getCitationGroup(doc.getElementById('cite_ref-2'))), ['cite_ref-2']);
});

test('getCitationGroup returns distinct wrappers for named-ref reuses', () => {
  // Wikipedia's named refs (e.g. <ref name="Foo"/> cited twice) produce two
  // distinct <sup class="reference"> wrappers whose <a> elements share the
  // same href (#cite_note-Foo). getCitationGroup must return wrapper
  // elements, not href targets, so a downstream mapping back to per-
  // occurrence citation entries can stay 1:1 — otherwise mapping by href
  // collides and one occurrence's group metadata gets dropped or
  // overwritten by the other group's. Regression: this is the shape that
  // produced "[1] (group [1][2])" with no group annotation on the [2] row
  // and a stale [3,5] group on what should have been [3,4].
  const doc = mkDoc(`
    <p>Fact A.<sup id="cite_ref-Foo_0" class="reference"><a href="#cite_note-Foo">[1]</a></sup><sup id="cite_ref-2" class="reference"><a href="#cite_note-2">[2]</a></sup> Fact B.<sup id="cite_ref-Foo_1" class="reference"><a href="#cite_note-Foo">[1]</a></sup><sup id="cite_ref-3" class="reference"><a href="#cite_note-3">[3]</a></sup></p>
  `);
  const groupA = getCitationGroup(doc.getElementById('cite_ref-Foo_0'));
  const groupB = getCitationGroup(doc.getElementById('cite_ref-Foo_1'));
  assert.deepEqual(refIds(groupA), ['cite_ref-Foo_0', 'cite_ref-2']);
  assert.deepEqual(refIds(groupB), ['cite_ref-Foo_1', 'cite_ref-3']);
  // The two reuses must surface as distinct DOM wrappers — not the same
  // element — so downstream code can pair each one with its own citation row.
  assert.notEqual(groupA[0], groupB[0]);
});

test('getCitationGroup handles mixed groups and singletons in the same paragraph', () => {
  // text [1][2] more text [3] more text [4][5]  →  three groups: {1,2}, {3}, {4,5}.
  const doc = mkDoc(`
    <p>First fact.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup><sup id="cite_ref-2" class="reference"><a href="#cite_note-2">[2]</a></sup> Second fact.<sup id="cite_ref-3" class="reference"><a href="#cite_note-3">[3]</a></sup> Third fact.<sup id="cite_ref-4" class="reference"><a href="#cite_note-4">[4]</a></sup><sup id="cite_ref-5" class="reference"><a href="#cite_note-5">[5]</a></sup></p>
  `);
  assert.deepEqual(refIds(getCitationGroup(doc.getElementById('cite_ref-1'))), ['cite_ref-1', 'cite_ref-2']);
  assert.deepEqual(refIds(getCitationGroup(doc.getElementById('cite_ref-2'))), ['cite_ref-1', 'cite_ref-2']);
  assert.deepEqual(refIds(getCitationGroup(doc.getElementById('cite_ref-3'))), ['cite_ref-3']);
  assert.deepEqual(refIds(getCitationGroup(doc.getElementById('cite_ref-4'))), ['cite_ref-4', 'cite_ref-5']);
  assert.deepEqual(refIds(getCitationGroup(doc.getElementById('cite_ref-5'))), ['cite_ref-4', 'cite_ref-5']);
});

test('cleanProse strips reference numbers and maintenance markers', () => {
  assert.equal(
    cleanProse('The sky is blue[1][failed verification] on clear days.'),
    'The sky is blue on clear days.'
  );
});

test('extractClaimContext returns the surrounding paragraph and section', () => {
  // The Jiménez case: the [2] fragment ("and the Premier League") is
  // uninterpretable alone; the paragraph supplies the subject.
  const doc = mkDoc(`
    <div id="mw-content-text">
      <div class="mw-heading mw-heading2"><h2 id="Club_career">Club career</h2><span class="mw-editsection">[edit]</span></div>
      <div class="mw-heading mw-heading3"><h3 id="Wolves">Wolverhampton Wanderers</h3><span class="mw-editsection">[edit]</span></div>
      <p>Jiménez won both Serie A<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup> and the Premier League<sup id="cite_ref-2" class="reference"><a href="#cite_note-2">[2]</a></sup>.</p>
    </div>
  `);
  const ctx = extractClaimContext(doc.getElementById('cite_ref-2'));
  assert.equal(ctx.sectionTitle, 'Club career › Wolverhampton Wanderers');
  assert.ok(ctx.paragraph.includes('Jiménez won both Serie A and the Premier League'));
  // The claim fragment itself stays the short between-citations text.
  assert.equal(extractClaimText(doc.getElementById('cite_ref-2')), 'and the Premier League');
});

test('extractSectionTitle handles the legacy mw-headline heading shape', () => {
  const doc = mkDoc(`
    <div id="mw-content-text">
      <h2><span class="mw-headline" id="Career">Career</span><span class="mw-editsection">[edit]</span></h2>
      <p>She received the Nobel Prize in Chemistry in 2015.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup></p>
    </div>
  `);
  assert.equal(extractSectionTitle(doc.getElementById('cite_ref-1')), 'Career');
});

test('extractSectionTitle returns empty string above the first heading', () => {
  const doc = mkDoc(`
    <div id="mw-content-text">
      <p>Lead sentence before any section.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup></p>
    </div>
  `);
  assert.equal(extractSectionTitle(doc.getElementById('cite_ref-1')), '');
});

test('claimNeedsDisambiguation: true for pronoun-led and fragment claims', () => {
  assert.equal(claimNeedsDisambiguation('She received the Nobel Prize in 2015.'), true);
  assert.equal(claimNeedsDisambiguation('He was a member of the committee.'), true);
  assert.equal(claimNeedsDisambiguation('They won the final.'), true);
  assert.equal(claimNeedsDisambiguation('It was completed in 1998.'), true);
  assert.equal(claimNeedsDisambiguation('and the Premier League'), true);   // mid-sentence fragment
  assert.equal(claimNeedsDisambiguation('having previously played for PHC Zebras'), true);
  assert.equal(claimNeedsDisambiguation('This treaty was signed in Paris.'), true);
});

test('claimNeedsDisambiguation: false for standalone claims with an explicit subject', () => {
  assert.equal(claimNeedsDisambiguation('Al Jazeera launched on 1 November 1996.'), false);
  assert.equal(claimNeedsDisambiguation('The company was founded in 1985 by John Smith.'), false);
  assert.equal(claimNeedsDisambiguation('Jiménez won both Serie A and the Premier League.'), false);
  assert.equal(claimNeedsDisambiguation(''), false);
  assert.equal(claimNeedsDisambiguation(null), false);
});
