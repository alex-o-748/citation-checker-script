import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractClaimText, getCitationGroup, MAINTENANCE_MARKER_RE } from '../core/claim.js';

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

test('extractClaimText stops at a preceding [citation needed] tag', () => {
  // Regression: prose like "Claim A.[citation needed] Claim B.<ref>" would
  // previously fold Claim A into Claim B's claim text because [citation
  // needed] isn't a <sup class="reference"> wrapper and so wasn't seen as a
  // boundary. The citation only attaches to "Claim B".
  const doc = mkDoc(`
    <p>he act did not include any power for it to be amended in Canada, so amendments had to be made by the British Parliament at the request of the Canadian Parliament.<sup class="noprint Inline-Template Template-Fact">[<i><a href="/wiki/Wikipedia:Citation_needed">citation needed</a></i>]</sup> That remained the case until Patriation of the Constitution in 1982, when the act was brought under full Canadian control and was renamed the Constitution Act, 1867.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup></p>
  `);
  const claim = extractClaimText(doc.getElementById('cite_ref-1'));
  assert.ok(!claim.includes('British Parliament'),
    `pre-marker claim leaked into post-marker claim: ${JSON.stringify(claim)}`);
  assert.ok(claim.includes('Patriation of the Constitution'));
  assert.ok(claim.includes('renamed the Constitution Act, 1867'));
});

test('extractClaimText stops at [citation needed] even when the words are joined by NBSP', () => {
  // Wikipedia renders {{citation needed}} inside white-space:nowrap, so the
  // visible text is "[citation needed]" rather than "[citation needed]".
  const doc = mkDoc(`
    <p>Unsupported claim text here.<sup class="noprint Inline-Template Template-Fact" style="white-space:nowrap;">[<i><a href="/wiki/Wikipedia:Citation_needed">citation needed</a></i>]</sup> Supported follow-up claim.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup></p>
  `);
  const claim = extractClaimText(doc.getElementById('cite_ref-1'));
  assert.ok(!claim.includes('Unsupported claim text'),
    `claim leaked across NBSP [citation needed]: ${JSON.stringify(claim)}`);
  assert.ok(claim.includes('Supported follow-up claim'));
});

test('extractClaimText slices to the LAST [citation needed] when multiple precede the citation', () => {
  const doc = mkDoc(`
    <p>First uncited claim.<sup class="noprint Inline-Template Template-Fact">[<i><a href="/wiki/Wikipedia:Citation_needed">citation needed</a></i>]</sup> Second uncited claim.<sup class="noprint Inline-Template Template-Fact">[<i><a href="/wiki/Wikipedia:Citation_needed">citation needed</a></i>]</sup> The cited claim.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup></p>
  `);
  const claim = extractClaimText(doc.getElementById('cite_ref-1'));
  assert.ok(!claim.includes('First uncited claim'));
  assert.ok(!claim.includes('Second uncited claim'));
  assert.ok(claim.includes('The cited claim'));
});

test('extractClaimText leaves [clarification needed] in place (not a claim boundary)', () => {
  // Inline maintenance markers that flag a specific phrase, not a whole
  // claim, should be stripped in-place rather than truncating the claim.
  const doc = mkDoc(`
    <p>The treaty was signed in the spring[clarification needed] of 1867.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup></p>
  `);
  const claim = extractClaimText(doc.getElementById('cite_ref-1'));
  assert.ok(claim.includes('The treaty was signed'),
    `non-boundary marker incorrectly split the claim: ${JSON.stringify(claim)}`);
  assert.ok(claim.includes('of 1867'));
  assert.ok(!claim.includes('clarification needed'));
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
