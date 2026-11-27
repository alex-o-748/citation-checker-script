import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { findSectionNumber, findSection, sectionIndexOfHeading, sectionIndexForAnchor, auditSectionNumbering } from '../core/sections.js';

// MW 1.43+ heading output: the <hN> and its [edit] link share a .mw-heading
// wrapper. `section` is the index MediaWiki assigned; pass null for a heading
// that renders without an edit link.
function heading(level, text, section) {
    const edit = section === null
        ? ''
        : `<span class="mw-editsection"><span class="mw-editsection-bracket">[</span>` +
          `<a href="/w/index.php?title=Test&amp;action=edit&amp;section=${section}">edit</a>` +
          `<span class="mw-editsection-bracket">]</span></span>`;
    return `<div class="mw-heading mw-heading${level}"><h${level} id="${text.replace(/\s/g, '_')}">${text}</h${level}>${edit}</div>`;
}

function ref(id) {
    return `<sup class="reference"><a id="${id}" href="#cite_note-${id}">[1]</a></sup>`;
}

function build(bodyHtml) {
    const dom = new JSDOM(`<!DOCTYPE html><body><div id="mw-content-text"><div class="mw-parser-output">${bodyHtml}</div></div></body>`);
    return dom.window.document;
}

test('citation in the lead resolves to section 0', () => {
    const doc = build(`<p>Lead ${ref('r')}</p>${heading(2, 'History', 1)}<p>Body</p>`);
    assert.equal(findSectionNumber(doc.getElementById('r')), 0);
});

test('uses the index MediaWiki assigned, not the ordinal position', () => {
    // The ordinal count says 2; MediaWiki numbered this section 6. A page with
    // headings that render without consuming an index of their own (or vice
    // versa) produces exactly this gap — the bug this module exists to avoid.
    const doc = build(`
        <p>Lead</p>
        ${heading(2, 'History', 5)}
        <p>Text</p>
        ${heading(3, 'Early years', 6)}
        <p>Claim ${ref('r')}</p>
    `);
    assert.equal(findSectionNumber(doc.getElementById('r')), 6);
});

test('walks past a transcluded heading to the enclosing page section', () => {
    const doc = build(`
        ${heading(2, 'Overview', 3)}
        <div class="mw-heading mw-heading3"><h3>From a template</h3><span class="mw-editsection"><a href="/w/index.php?title=Template:X&amp;action=edit&amp;section=T-1">edit</a></span></div>
        <p>Claim ${ref('r')}</p>
    `);
    assert.equal(findSectionNumber(doc.getElementById('r')), 3);
});

test('ignores a heading that carries no edit link and keeps walking back', () => {
    // e.g. the "Contents" <h2> legacy skins render inside #mw-content-text.
    const doc = build(`
        ${heading(2, 'Reception', 4)}
        <div class="toc"><h2>Contents</h2></div>
        <p>Claim ${ref('r')}</p>
    `);
    assert.equal(findSectionNumber(doc.getElementById('r')), 4);
});

test('falls back to counting when the page renders no edit links at all', () => {
    const doc = build(`
        ${heading(2, 'One', null)}
        ${heading(2, 'Two', null)}
        <p>Claim ${ref('r')}</p>
    `);
    assert.equal(findSectionNumber(doc.getElementById('r')), 2);
});

test('returns 0 rather than a guess when only transcluded sections precede', () => {
    const doc = build(`
        <div class="mw-heading mw-heading2"><h2>Template heading</h2><span class="mw-editsection"><a href="/w/index.php?title=Template:X&amp;action=edit&amp;section=T-1">edit</a></span></div>
        <p>Claim ${ref('r')}</p>
    `);
    assert.equal(findSectionNumber(doc.getElementById('r')), 0);
});

test('returns 0 when the article body is missing', () => {
    const dom = new JSDOM(`<!DOCTYPE html><body><p><a id="r" href="#x">[1]</a></p></body>`);
    assert.equal(findSectionNumber(dom.window.document.getElementById('r')), 0);
    assert.equal(findSectionNumber(null), 0);
});

test('sectionIndexOfHeading reads the index off pre-1.43 heading markup', () => {
    const doc = build(`<h2 id="h">Legacy<span class="mw-editsection"><a href="/w/index.php?title=Test&amp;action=edit&amp;section=7">edit</a></span></h2>`);
    assert.equal(sectionIndexOfHeading(doc.getElementById('h')), 7);
});

test('auditSectionNumbering flags where the count and MediaWiki disagree', () => {
    const doc = build(`${heading(2, 'One', 1)}${heading(2, 'Two', 5)}`);
    const rows = auditSectionNumbering(doc);
    assert.deepEqual(rows.map(r => r.matches), [true, false]);
    assert.deepEqual(rows.map(r => [r.counted, r.actual]), [[1, 1], [2, 5]]);
});

// Mass media, 2026-11-27: a "Japan" section was added above United Kingdom
// while a report was open, so the Audiovisual citation's index from the page
// on screen (9) was Radio's in the latest revision, which is what the edit
// form opens. The anchor finds the section again.
test('findSection returns the anchor of the heading the index came from', () => {
    const doc = build(`
        ${heading(4, 'Radio', 8)}
        <p>Radio claim</p>
        ${heading(4, 'Audiovisual', 9)}
        <div class="mw-heading mw-heading3"><h3>From a template</h3><span class="mw-editsection"><a href="/w/index.php?title=Template:X&amp;action=edit&amp;section=T-1">edit</a></span></div>
        <p>Claim ${ref('r')}</p>
    `);
    assert.deepEqual(findSection(doc.getElementById('r')), { index: 9, anchor: 'Audiovisual' });
});

test('findSection reads a pre-1.43 anchor off the .mw-headline span', () => {
    const doc = build(`<h2><span class="mw-headline" id="Legacy">Legacy</span><span class="mw-editsection"><a href="/w/index.php?title=Test&amp;action=edit&amp;section=3">edit</a></span></h2><p>${ref('r')}</p>`);
    assert.deepEqual(findSection(doc.getElementById('r')), { index: 3, anchor: 'Legacy' });
});

test('findSection gives no anchor for the lead', () => {
    const doc = build(`<p>Lead ${ref('r')}</p>${heading(2, 'History', 1)}`);
    assert.deepEqual(findSection(doc.getElementById('r')), { index: 0, anchor: null });
});

test('sectionIndexForAnchor finds the heading in the latest revision', () => {
    const latest = [
        { index: '8', anchor: 'Print' },
        { index: '9', anchor: 'Radio' },
        { index: '10', anchor: 'Audiovisual' },
        { index: '11', anchor: 'Radio_2' },
    ];
    assert.equal(sectionIndexForAnchor(latest, 'Audiovisual'), 10);
    assert.equal(sectionIndexForAnchor(latest, 'Radio'), 9);
    assert.equal(sectionIndexForAnchor(latest, 'Removed'), null);
    assert.equal(sectionIndexForAnchor(latest, null), null);
    assert.equal(sectionIndexForAnchor([{ index: 'T-1', anchor: 'X' }], 'X'), null);
});
