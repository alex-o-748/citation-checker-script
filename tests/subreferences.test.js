import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { collectCitations } from '../core/citations.js';
import { extractReferenceUrl, extractPageNumber, subreferenceParent, footnoteText } from '../core/urls.js';
import { parseCliArgs, findReferenceByCitationNumber } from '../cli/verify.js';

// Sub-referencing: <ref name="Miller" details="p. 627" />. Fixtures follow the
// markup de.wikipedia rendered for "Deutsche Nationalbibliothek" on
// 2026-10-09, in both renderings — the legacy parser (the main ref's <li> has
// no id when nothing cites it directly) and Parsoid (it gets
// cite_note-<name>-<n>, and inline hrefs are ./Title#cite_note-<n>).
//
// The point of the feature for us: the inline [10.1] marker points at an <li>
// holding only "p. 627." — the source is in the enclosing main reference.

const BOOK = 'https://books.example.org/miller';
const DEEP = 'https://books.example.org/miller?page=627';
const link = url => `<a rel="nofollow" class="external text" href="${url}">link</a>`;

function sup(id, label, prefix) {
    return `<sup id="cite_ref-${id}" class="reference"><a href="${prefix}#cite_note-${id}">` +
        `<span class="cite-bracket">[</span>${label}<span class="cite-bracket">]</span></a></sup>`;
}

// `subrefs` maps footnote id -> [label, details html].
function buildDoc({ parsoid = false, mainId, mainHtml, subrefs, citeMain = false }) {
    const prefix = parsoid ? './Test_article' : '';
    const markers = Object.entries(subrefs).map(([id, [label]]) =>
        `<p>The library was founded in a hurry by the committee.${sup(id, label, prefix)}</p>`).join('');
    const mainMarker = citeMain ? `<p>The book covers the whole history of it.${sup(mainId, '10', prefix)}</p>` : '';
    const items = Object.entries(subrefs).map(([id, [, details]]) =>
        `<li id="cite_note-${id}"><span class="mw-cite-backlink"><a href="#cite_ref-${id}">↑</a></span> ` +
        `<span class="reference-text">${details}</span></li>`).join('');
    const mainAttr = (parsoid || citeMain) ? ` id="cite_note-${mainId}"` : '';
    const html = `<div id="mw-content-text">${mainMarker}${markers}<ol class="references">` +
        `<li${mainAttr}><span class="mw-cite-backlink">↑</span> <span class="reference-text">${mainHtml}</span>` +
        `<ol class="mw-subreference-list">${items}</ol></li></ol></div>`;
    return parsoid ? JSDOM.fragment(html) : new JSDOM(`<!DOCTYPE html><body>${html}</body>`).window.document;
}

test('subreferenceParent finds the main reference, and only for a sub-reference', () => {
    const doc = buildDoc({ mainId: 'Miller-10', mainHtml: `Miller: Book. ${link(BOOK)}`, subrefs: { 11: ['10.1', 'p. 627.'] } });
    const main = subreferenceParent(doc.getElementById('cite_note-11'));
    assert.ok(main);
    assert.match(main.textContent, /Miller: Book/);
    assert.equal(subreferenceParent(main), null);
    assert.equal(subreferenceParent(null), null);
});

for (const parsoid of [false, true]) {
    const label = parsoid ? 'Parsoid' : 'legacy parser';

    test(`${label}: a sub-reference resolves its URL from the main reference`, () => {
        const doc = buildDoc({ parsoid, mainId: 'Miller-10', mainHtml: `Miller: Book. ${link(BOOK)}`,
            subrefs: { 11: ['10.1', 'p. 627.'], 12: ['10.2', 'p. 33.'] } });
        const citations = collectCitations(doc);
        assert.equal(citations.length, 2);
        assert.deepEqual(citations.map(c => c.citationNumber), ['10.1', '10.2']);
        assert.deepEqual(citations.map(c => c.url), [BOOK, BOOK]);
        assert.deepEqual(citations.map(c => c.pageNum), [627, 33]);
        // Only Parsoid puts the ref name anywhere a sub-reference can reach.
        assert.deepEqual(citations.map(c => c.refName), parsoid ? ['Miller', 'Miller'] : [null, null]);
    });
}

test('a link in the details wins over the main reference: it is the deep link to the cited place', () => {
    const doc = buildDoc({ mainId: 'Miller-10', mainHtml: `Miller: Book. ${link(BOOK)}`,
        subrefs: { 11: ['10.1', `p. 627, ${link(DEEP)}`], 12: ['10.2', 'p. 33.'] } });
    const [deep, plain] = collectCitations(doc);
    assert.equal(deep.url, DEEP);
    assert.equal(plain.url, BOOK);
});

test("a main reference cited directly ignores its sub-references' links and pages", () => {
    // Main ref is an offline book; one sub-reference links a scanned page.
    // Before, [10] would have been "verified" against [10.1]'s page link, at
    // [10.1]'s page.
    const doc = buildDoc({ mainId: 'Miller-10', citeMain: true, mainHtml: 'Miller: Book. Wallstein, 2018.',
        subrefs: { 11: ['10.1', `p. 627, ${link(DEEP)}`] } });
    const [main, sub] = collectCitations(doc);
    assert.equal(main.citationNumber, '10');
    assert.equal(main.url, null);
    assert.equal(main.pageNum, null);
    assert.equal(sub.url, DEEP);
    assert.equal(sub.pageNum, 627);
});

test('a sub-reference takes its page from the details only, never from the main reference', () => {
    // "pp. 600–700" is the chapter's range; fetching only page 600 of the PDF
    // would hide the cited page.
    const doc = buildDoc({ mainId: 'Miller-10', mainHtml: `Miller: Chapter. pp. 600–700. ${link(BOOK)}`,
        subrefs: { 11: ['10.1', 'Table 3.'] } });
    const [sub] = collectCitations(doc);
    assert.equal(sub.url, BOOK);
    assert.equal(sub.pageNum, null);
});

test('a sub-reference of a Harvard/sfn short-cite follows the #CITEREF to the full citation', () => {
    const doc = new JSDOM(`<!DOCTYPE html><body><div id="mw-content-text">
        <p>A claim long enough to be checked.${sup(11, '1.1', '')}</p>
        <ol class="references"><li><span class="reference-text"><a href="#CITEREFMiller2018">Miller 2018</a></span>
          <ol class="mw-subreference-list"><li id="cite_note-11"><span class="reference-text">p. 5.</span></li></ol></li></ol>
        <ul><li><cite id="CITEREFMiller2018">Miller. <i>Book</i>. ${link(BOOK)}</cite></li></ul>
    </div></body>`).window.document;
    const ref = doc.querySelector('.reference a');
    assert.equal(extractReferenceUrl(ref, doc), BOOK);
    assert.equal(extractPageNumber(ref, doc), 5);
});

test('footnoteText drops nested sub-references without touching the document', () => {
    const doc = buildDoc({ mainId: 'Miller-10', mainHtml: 'Miller: Book.', subrefs: { 11: ['10.1', 'p. 627.'] } });
    const main = subreferenceParent(doc.getElementById('cite_note-11'));
    assert.doesNotMatch(footnoteText(main), /627/);
    assert.match(main.textContent, /627/);
    assert.equal(footnoteText(doc.getElementById('cite_note-11')).trim(), '↑ p. 627.');
});

test('ccs verify accepts N.M for a sub-reference and finds its [N.M] marker', () => {
    const argv = n => ['node', 'ccs', 'verify', 'https://en.wikipedia.org/wiki/Foo', n];
    assert.equal(parseCliArgs(argv('10.1')).citationNumber, '10.1');
    // Not Number(): that would turn 10.10 into 10.1, a different footnote.
    assert.equal(parseCliArgs(argv('10.10')).citationNumber, '10.10');
    assert.equal(parseCliArgs(argv('10')).citationNumber, 10);
    for (const bad of ['0.1', '10.', '.1', '10.1.2']) {
        assert.throws(() => parseCliArgs(argv(bad)), /citation number/i, bad);
    }

    const doc = buildDoc({ mainId: 'Miller-10', mainHtml: 'Miller.', subrefs: { 11: ['10.1', 'p. 1.'], 12: ['10.10', 'p. 2.'] } });
    assert.equal(findReferenceByCitationNumber(doc, '10.10').id, 'cite_ref-12');
    assert.equal(findReferenceByCitationNumber(doc, 10), null);
});
