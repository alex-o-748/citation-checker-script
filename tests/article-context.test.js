import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { collectCitations } from '../core/citations.js';
import { attachArticleContext, articleCategories, MAX_PARAGRAPH_CHARS } from '../core/article-context.js';
import { isBlpByCategories } from '../service/article-picker.js';

const ref = id => `<sup id="cite_ref-${id}" class="reference mw-ref"><a href="./Test#cite_note-${id}">[${id}]</a></sup>`;
const notes = ids => `<ol class="references">${ids.map(id =>
    `<li id="cite_note-${id}"><a class="external" href="https://x.example/${id}">s</a></li>`).join('')}</ol>`;

function contextFor(html) {
    const root = JSDOM.fragment(html);
    const citations = collectCitations(root, { claimScope: 'sentence' });
    attachArticleContext(citations, root);
    return Object.fromEntries(citations.map(c => [c.citationNumber, c]));
}

test('Parsoid <section> markup: lead is null, nested headings form a path', () => {
    const byNumber = contextFor(
        `<section data-mw-section-id="0"><p>Lead sentence about the band.${ref(1)}</p></section>` +
        '<section data-mw-section-id="1"><h2 id="Career">Career</h2>' +
        `<p>They formed in 1998 in Leeds.${ref(2)}</p>` +
        '<section data-mw-section-id="2"><h3 id="Music">Music</h3>' +
        `<p>Their first album sold well.${ref(3)}</p></section></section>` +
        '<section data-mw-section-id="3"><h2 id="Legacy">Legacy</h2>' +
        `<ul><li>Covered by many later acts.${ref(4)}</li></ul></section>` +
        notes([1, 2, 3, 4])
    );
    assert.equal(byNumber['1'].sectionTitle, null, 'lead');
    assert.equal(byNumber['2'].sectionTitle, 'Career');
    assert.equal(byNumber['3'].sectionTitle, 'Career > Music');
    assert.equal(byNumber['4'].sectionTitle, 'Legacy', 'an h2 closes the h3 path');
    assert.equal(byNumber['4'].paragraphText, 'Covered by many later acts.', 'list item stands in for a paragraph');
});

test('browser skin markup: flat content, edit links stripped from the heading', () => {
    const byNumber = contextFor(
        '<div class="mw-heading mw-heading2"><h2 id="History">History</h2>' +
        '<span class="mw-editsection">[<a href="#">edit</a>]</span></div>' +
        `<p>The bridge opened in 1998.${ref(1)}</p>` +
        '<h2><span class="mw-headline" id="Design">Design</span><span class="mw-editsection">[edit]</span></h2>' +
        `<p>It is a suspension bridge.${ref(2)}</p>` +
        notes([1, 2])
    );
    assert.equal(byNumber['1'].sectionTitle, 'History');
    assert.equal(byNumber['2'].sectionTitle, 'Design');
});

test('a skipped heading level does not leave an empty path segment', () => {
    const byNumber = contextFor(`<h2>History</h2><h4>Detail</h4><p>Something happened then.${ref(1)}</p>${notes([1])}`);
    assert.equal(byNumber['1'].sectionTitle, 'History > Detail');
});

test('paragraph text drops footnote markers and is shared by citations in one paragraph', () => {
    const byNumber = contextFor(
        `<h2>History</h2><p>The bridge opened in 1998.${ref(1)} It cost $200 million to build.${ref(2)}</p>${notes([1, 2])}`
    );
    const expected = 'The bridge opened in 1998. It cost $200 million to build.';
    assert.equal(byNumber['1'].paragraphText, expected);
    assert.equal(byNumber['2'].paragraphText, expected);
});

test('an over-long paragraph is capped', () => {
    const long = 'word '.repeat(MAX_PARAGRAPH_CHARS);
    const byNumber = contextFor(`<p>${long}and the claim itself.${ref(1)}</p>${notes([1])}`);
    assert.ok(byNumber['1'].paragraphText.length <= MAX_PARAGRAPH_CHARS + 1);
    assert.ok(byNumber['1'].paragraphText.endsWith('…'));
});

test('articleCategories reads Parsoid category links, decoded, sort keys dropped, prefix not checked', () => {
    const root = JSDOM.fragment(
        '<p>x</p>' +
        '<link rel="mw:PageProp/Category" href="./Category:Living_people#Smith,%20Anna">' +
        '<link rel="mw:PageProp/Category" href="./Category:1970_births">' +
        '<link rel="mw:PageProp/Category" href="./%D0%9A%D0%B0%D1%82%D0%B5%D0%B3%D0%BE%D1%80%D0%B8%D1%8F:%D0%9F%D0%B8%D1%81%D0%B0%D1%82%D0%B5%D0%BB%D0%B8">' +
        '<link rel="mw:PageProp/Category" href="./Category:Living_people">'
    );
    assert.deepEqual(articleCategories(root), ['Living people', '1970 births', 'Писатели']);
});

test('isBlpByCategories: true/false on enwiki, null where no category is confirmed', () => {
    assert.equal(isBlpByCategories(['1970 births', 'Living people'], 'enwiki'), true);
    assert.equal(isBlpByCategories(['1970 births'], 'enwiki'), false);
    assert.equal(isBlpByCategories(undefined, 'enwiki'), false);
    assert.equal(isBlpByCategories(['Living people'], 'ruwiki'), null, "can't tell is not no");
});

test('context extraction stays linear: cost per citation is flat as a flat article grows', () => {
    // The browser skin has no <section> wrappers, which is where a per-citation
    // backwards search would go quadratic. Same shape as tests/claim.test.js's
    // guard.
    const build = n => {
        let html = '';
        for (let i = 1; i <= n; i++) {
            if (i % 5 === 1) html += `<h2>Section ${i}</h2>`;
            html += `<p>Sentence number ${i} is here.${ref(i)}</p>`;
        }
        return html + notes(Array.from({ length: n }, (_, i) => i + 1));
    };
    const perCitation = n => {
        const root = JSDOM.fragment(build(n));
        const citations = collectCitations(root, { claimScope: 'sentence' });
        const start = process.hrtime.bigint();
        attachArticleContext(citations, root);
        return Number(process.hrtime.bigint() - start) / n;
    };
    perCitation(50); // warm-up
    const small = perCitation(100);
    const large = perCitation(800);
    assert.ok(large < small * 4, `per-citation cost grew ${(large / small).toFixed(1)}x for 8x the article`);
});
