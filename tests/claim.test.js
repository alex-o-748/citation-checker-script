import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractClaimText, getCitationGroup, hasTextBetween, lastSentence, MAINTENANCE_MARKER_RE } from '../core/claim.js';

function mkDoc(html) {
  return new JSDOM(`<!DOCTYPE html><body>${html}</body>`).window.document;
}

// Builds an article of `paragraphs` paragraphs, each carrying `refsPerPara`
// citations, for the scaling guard below.
function mkArticle(paragraphs, refsPerPara = 3) {
  const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '.repeat(3);
  let n = 0;
  let html = '';
  for (let p = 0; p < paragraphs; p++) {
    html += '<section><h2>Section</h2><p>';
    for (let r = 0; r < refsPerPara; r++) {
      n++;
      html += `${filler}.<sup id="cite_ref-${n}" class="reference"><a href="#cite_note-${n}">[${n}]</a></sup>`;
    }
    html += '</p></section>';
  }
  html += '<ol class="mw-references">';
  for (let i = 1; i <= n; i++) {
    html += `<li id="cite_note-${i}"><cite>Author ${i}. <a href="https://example.com/${i}">Title</a>.</cite></li>`;
  }
  return { doc: mkDoc(html + '</ol>'), refCount: n };
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

test('lastSentence returns the final sentence of a multi-sentence claim', () => {
  const text = 'Water boils at 100 degrees Celsius. It freezes at 0 degrees Celsius.';
  assert.equal(lastSentence(text), 'It freezes at 0 degrees Celsius.');
});

test('lastSentence returns the whole string when it is a single sentence', () => {
  const text = 'Water boils at 100 degrees Celsius.';
  assert.equal(lastSentence(text), text);
});

test('extractClaimText with scope "sentence" narrows a two-sentence claim to the last sentence', () => {
  const doc = mkDoc(`
    <p>Paris is the capital of France. It is on the Seine.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup></p>
  `);
  const ref = doc.getElementById('cite_ref-1');
  const fullClaim = extractClaimText(ref);
  const sentenceClaim = extractClaimText(ref, { scope: 'sentence' });
  assert.ok(fullClaim.includes('Paris is the capital of France'), `full-scope claim lost the first sentence: ${fullClaim}`);
  assert.equal(sentenceClaim, 'It is on the Seine.');
});

test('extractClaimText with scope "sentence" returns the same text as default scope for a single-sentence claim', () => {
  const doc = mkDoc(`
    <p>The boiling point of water is 100 degrees Celsius.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup></p>
  `);
  const ref = doc.getElementById('cite_ref-1');
  assert.equal(extractClaimText(ref, { scope: 'sentence' }), extractClaimText(ref));
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

test('claim extraction never constructs a DOM Range', () => {
  // Range.toString() and the setStart/setEnd boundary checks behind it are
  // O(document) under JSDOM — jsdom's boundary comparison walks forward from
  // one node through the rest of the document looking for the other. Calling
  // that once per citation made batch extraction quadratic in article length
  // (a 960-citation article spent ~40s here; the walk in core/claim.js does it
  // in ~70ms). A browser's native Range would hide the cost, so the guard is
  // structural rather than a timing assertion: if a Range comes back into this
  // path, this fails immediately instead of at Toolforge scale.
  const { doc } = mkArticle(4);
  doc.createRange = () => { throw new Error('claim extraction must not use Range — see core/claim.js'); };

  for (const ref of doc.querySelectorAll('.reference')) {
    extractClaimText(ref);
    getCitationGroup(ref);
  }
  const refs = Array.from(doc.querySelectorAll('.reference'));
  hasTextBetween(refs[0], refs[1]);
});

test('claim extraction cost per citation stays flat as the article grows', () => {
  // Companion to the Range guard: pins the *scaling*, so a future change that
  // reintroduces an O(document) step by some other route is still caught. The
  // margin is deliberately loose — this asserts "not quadratic", not a
  // millisecond budget. The Range implementation grew ~30x here.
  const perRef = [];
  for (const paragraphs of [10, 80]) {
    const { doc, refCount } = mkArticle(paragraphs);
    const refs = Array.from(doc.querySelectorAll('.reference'));
    const started = performance.now();
    for (const ref of refs) {
      extractClaimText(ref);
      getCitationGroup(ref);
    }
    perRef.push((performance.now() - started) / refCount);
  }

  const growth = perRef[1] / perRef[0];
  assert.ok(growth < 5,
    `per-citation cost grew ${growth.toFixed(1)}x when the article grew 8x — extraction is superlinear again`);
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
