import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { collectCitations, attachGroupMetadata, refIdFromHref, refNameFromNoteId } from '../core/citations.js';

// Builds a document shaped like rendered Wikipedia article HTML: inline
// <sup class="reference"> anchors in the prose, and a footnote list whose <li>
// ids match the anchors' fragments.
//
// `hrefStyle` switches between the two real-world renderings:
//   'browser' -> href="#cite_note-N"            (MediaWiki skin)
//   'parsoid' -> href="./Article#cite_note-N"   (REST API output)
function buildDoc(prose, footnotes, { hrefStyle = 'browser' } = {}) {
    const prefix = hrefStyle === 'parsoid' ? './Test_article' : '';
    const body = prose.replace(/@@(\S+?)@@/g, (_, id) =>
        `<sup id="cite_ref-${id}" class="reference"><a href="${prefix}#cite_note-${id}">[${id}]</a></sup>`
    );
    const list = Object.entries(footnotes)
        .map(([id, html]) => `<li id="cite_note-${id}">${html}</li>`)
        .join('');
    return new JSDOM(
        `<!DOCTYPE html><body><div id="mw-content-text">${body}<ol class="references">${list}</ol></div></body>`
    ).window.document;
}

const link = url => `<a rel="nofollow" class="external text" href="${url}">source</a>`;

test('refIdFromHref handles both browser and Parsoid anchor forms', () => {
    assert.equal(refIdFromHref('#cite_note-1'), 'cite_note-1');
    assert.equal(refIdFromHref('./Great_Migration#cite_note-1'), 'cite_note-1');
    assert.equal(refIdFromHref('/wiki/Foo#cite_note-x'), 'cite_note-x');
    assert.equal(refIdFromHref('#'), null, 'empty fragment is not a footnote');
    assert.equal(refIdFromHref('https://example.com/page'), null, 'no fragment');
    assert.equal(refIdFromHref(''), null);
    assert.equal(refIdFromHref(null), null);
});

test('collects a solo citation with its claim, url and page number', () => {
    const doc = buildDoc(
        '<p>The bridge opened to traffic in 1998.@@1@@</p>',
        { 1: `Smith, J. ${link('https://example.com/bridge')} p. 42` }
    );

    const citations = collectCitations(doc.getElementById('mw-content-text'));

    assert.equal(citations.length, 1);
    const [c] = citations;
    assert.equal(c.citationNumber, '1');
    assert.equal(c.claimText, 'The bridge opened to traffic in 1998.');
    assert.equal(c.url, 'https://example.com/bridge');
    assert.equal(c.pageNum, 42);
    assert.equal(c.refId, 'cite_note-1');
    assert.equal(c.refName, null, 'an unnamed ref has no name to recover');
    // A lone citation is still a group, of size one.
    assert.equal(c.groupSize, 1);
    assert.equal(c.groupIndex, 0);
});

test('refNameFromNoteId recovers a named ref\'s sanitized name from its footnote id', () => {
    assert.equal(refNameFromNoteId('cite_note-smith2001-1'), 'smith2001');
    assert.equal(refNameFromNoteId('cite_note-John_Smith_2001-3'), 'John_Smith_2001');
});

test('refNameFromNoteId returns null for an unnamed ref\'s plain numbered id', () => {
    assert.equal(refNameFromNoteId('cite_note-1'), null);
    assert.equal(refNameFromNoteId('cite_note-42'), null);
});

test('refNameFromNoteId handles a purely numeric name via the trailing counter split', () => {
    // <ref name="2"> renders as cite_note-2-5 (name "2", counter 5) — still
    // recoverable, distinct from the unnamed cite_note-5 case above.
    assert.equal(refNameFromNoteId('cite_note-2-5'), '2');
});

test('refNameFromNoteId handles empty and missing input without throwing', () => {
    assert.equal(refNameFromNoteId(''), null);
    assert.equal(refNameFromNoteId(null), null);
    assert.equal(refNameFromNoteId(undefined), null);
});

test('a named ref cited once collects its ref name from the footnote id', () => {
    const doc = buildDoc(
        '<p>The bridge opened in 1998.@@smith2001-1@@</p>',
        { 'smith2001-1': `Smith, J. ${link('https://example.com/bridge')}` }
    );
    const [c] = collectCitations(doc.getElementById('mw-content-text'));
    assert.equal(c.refName, 'smith2001');
});

test('a named ref cited twice carries the same ref name on both occurrences', () => {
    const doc = buildDoc(
        `<p>First claim about the bridge.@@smith2001-1@@ Second, separate claim.@@smith2001-1@@</p>`,
        { 'smith2001-1': `Smith, J. ${link('https://example.com/bridge')}` }
    );
    const citations = collectCitations(doc.getElementById('mw-content-text'));
    assert.equal(citations.length, 2);
    assert.equal(citations[0].refName, 'smith2001');
    assert.equal(citations[1].refName, 'smith2001');
});

test('adjacent citations share one group; a text break starts a new one', () => {
    const doc = buildDoc(
        '<p>The treaty was signed in Paris in 1990.@@1@@@@2@@ It was later revised.@@3@@</p>',
        {
            1: link('https://example.com/a'),
            2: link('https://example.com/b'),
            3: link('https://example.com/c'),
        }
    );

    const citations = collectCitations(doc.getElementById('mw-content-text'));
    assert.equal(citations.length, 3);

    const [one, two, three] = citations;
    assert.equal(one.groupSize, 2);
    assert.equal(two.groupSize, 2);
    assert.equal(one.groupId, two.groupId, '[1][2] are adjacent, so one group');
    assert.deepEqual(one.groupCitationNumbers, ['1', '2']);
    assert.equal(one.groupIndex, 0);
    assert.equal(two.groupIndex, 1);

    assert.equal(three.groupSize, 1, 'prose between [2] and [3] breaks the group');
    assert.notEqual(three.groupId, one.groupId);
});

test('punctuation between adjacent refs breaks the group', () => {
    const doc = buildDoc(
        '<p>Several sources agree.@@1@@, @@2@@</p>',
        { 1: link('https://example.com/a'), 2: link('https://example.com/b') }
    );

    const citations = collectCitations(doc.getElementById('mw-content-text'));
    assert.equal(citations.length, 2);
    assert.equal(citations[0].groupSize, 1);
    assert.equal(citations[1].groupSize, 1);
});

test('works against Parsoid-style hrefs, which do not start with #', () => {
    const doc = buildDoc(
        '<p>The bridge opened to traffic in 1998.@@1@@</p>',
        { 1: link('https://example.com/bridge') },
        { hrefStyle: 'parsoid' }
    );

    // Parsoid output has no #mw-content-text wrapper, so the document is the root.
    const citations = collectCitations(doc);

    assert.equal(citations.length, 1, 'Parsoid anchors must not be skipped');
    assert.equal(citations[0].refId, 'cite_note-1');
    assert.equal(citations[0].url, 'https://example.com/bridge');
});

test('a short leading claim falls back to the container text rather than being dropped', () => {
    // extractClaimText() has its own fallback: when the between-citations slice
    // comes out under 10 characters it returns the whole container instead. So
    // "Yes." does not reach collectCitations()'s guard — it arrives as the full
    // paragraph. Pinning this down because the two thresholds look like they
    // duplicate each other and don't.
    const doc = buildDoc(
        '<p>Yes.@@1@@ The bridge opened to traffic in 1998.@@2@@</p>',
        { 1: link('https://example.com/a'), 2: link('https://example.com/b') }
    );

    const citations = collectCitations(doc.getElementById('mw-content-text'));

    assert.deepEqual(citations.map(c => c.citationNumber), ['1', '2']);
    assert.equal(
        citations[0].claimText,
        'Yes. The bridge opened to traffic in 1998.',
        'short slice falls back to the whole container'
    );
    assert.equal(
        citations[1].claimText,
        'The bridge opened to traffic in 1998.',
        'the second citation still gets its own between-citations slice'
    );
});

test('drops a citation when even the container text is too short', () => {
    // The guard in collectCitations() only bites once extractClaimText()'s own
    // fallback has also come up short — i.e. the whole container is trivial.
    const doc = buildDoc(
        '<p>Yes.@@1@@</p>',
        { 1: link('https://example.com/a') }
    );

    assert.deepEqual(collectCitations(doc.getElementById('mw-content-text')), []);
});

test('minClaimLength is configurable', () => {
    const doc = buildDoc(
        '<p>Yes.@@1@@</p>',
        { 1: link('https://example.com/a') }
    );

    const root = doc.getElementById('mw-content-text');
    assert.equal(collectCitations(root).length, 0);
    assert.equal(collectCitations(root, { minClaimLength: 1 }).length, 1);
});

test('a citation with no fetchable URL is kept, with url null', () => {
    const doc = buildDoc(
        '<p>The bridge opened to traffic in 1998.@@1@@</p>',
        { 1: 'Smith, J. <i>A History of Bridges</i>, 2001. ISBN 978-0000000000' }
    );

    const citations = collectCitations(doc.getElementById('mw-content-text'));
    assert.equal(citations.length, 1, 'offline sources still surface as citations');
    assert.equal(citations[0].url, null);
});

test('the same named ref cited twice yields two distinct citations', () => {
    // Both occurrences point at the same footnote, as {{r|Foo}} does.
    const doc = new JSDOM(`<!DOCTYPE html><body><div id="mw-content-text">
        <p>The first claim about the bridge is here.<sup id="cite_ref-a-0" class="reference"><a href="#cite_note-a">[1]</a></sup></p>
        <p>A separate later claim about the bridge.<sup id="cite_ref-a-1" class="reference"><a href="#cite_note-a">[1]</a></sup></p>
        <ol class="references"><li id="cite_note-a">${link('https://example.com/a')}</li></ol>
    </div></body>`).window.document;

    const citations = collectCitations(doc.getElementById('mw-content-text'));

    assert.equal(citations.length, 2, 'each occurrence is its own citation');
    assert.notEqual(
        citations[0].groupId, citations[1].groupId,
        'occurrences in different paragraphs must not collapse into one group'
    );
    assert.equal(citations[0].groupSize, 1);
    assert.equal(citations[1].groupSize, 1);
});

test('returns an empty array for a root with no citations, and for no root', () => {
    const doc = buildDoc('<p>Nothing cited here at all.</p>', {});
    assert.deepEqual(collectCitations(doc.getElementById('mw-content-text')), []);
    assert.deepEqual(collectCitations(null), []);
    assert.deepEqual(collectCitations(undefined), []);
});

test('attachGroupMetadata is idempotent', () => {
    const doc = buildDoc(
        '<p>The treaty was signed in Paris in 1990.@@1@@@@2@@</p>',
        { 1: link('https://example.com/a'), 2: link('https://example.com/b') }
    );

    const citations = collectCitations(doc.getElementById('mw-content-text'));
    const before = citations.map(c => ({ ...c, refElement: undefined }));
    attachGroupMetadata(citations);
    const after = citations.map(c => ({ ...c, refElement: undefined }));

    assert.deepEqual(after, before, 're-running must not change group assignment');
});
