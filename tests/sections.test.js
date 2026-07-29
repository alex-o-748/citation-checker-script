import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    findSectionNumber,
    sectionIndexOfHeading,
    sectionTargetFor,
    resolveSectionIndex,
    auditSectionNumbering,
} from '../core/sections.js';

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

// --- surviving edits made after the page was rendered -----------------------

// action=parse&prop=sections shape, trimmed to the fields we use.
function apiSections(...entries) {
    return entries.map(([index, line, anchor]) => ({ index: String(index), line, anchor, level: '2' }));
}

test('sectionTargetFor captures the anchor alongside the rendered index', () => {
    const doc = build(`${heading(2, 'Reception', 4)}<p>Claim ${ref('r')}</p>`);
    assert.deepEqual(sectionTargetFor(doc.getElementById('r')), {
        index: 4,
        anchor: 'Reception',
        line: 'Reception',
    });
});

test('sectionTargetFor reads the anchor off pre-1.43 .mw-headline markup', () => {
    const doc = build(`
        <h2><span class="mw-headline" id="Legacy_anchor">Legacy</span><span class="mw-editsection"><a href="/w/index.php?title=T&amp;action=edit&amp;section=2">edit</a></span></h2>
        <p>Claim ${ref('r')}</p>
    `);
    assert.deepEqual(sectionTargetFor(doc.getElementById('r')), {
        index: 2,
        anchor: 'Legacy_anchor',
        line: 'Legacy',
    });
});

test('sectionTargetFor reports the lead as section 0 with no anchor', () => {
    const doc = build(`<p>Lead ${ref('r')}</p>${heading(2, 'History', 1)}`);
    assert.deepEqual(sectionTargetFor(doc.getElementById('r')), { index: 0, anchor: null, line: null });
});

test('resolveSectionIndex follows a section that shifted down after new sections were added', () => {
    // The regression this whole path exists for: the button was built when
    // "Reception" was section 4, then four sections were inserted above it.
    const target = { index: 4, anchor: 'Reception', line: 'Reception' };
    const live = apiSections(
        [1, 'Background', 'Background'], [2, 'Origins', 'Origins'], [3, 'Design', 'Design'],
        [4, 'Development', 'Development'], [5, 'Release', 'Release'],
        [8, 'Reception', 'Reception'],
    );
    assert.equal(resolveSectionIndex(live, target), 8);
});

test('resolveSectionIndex matches on heading text when the anchor changed', () => {
    const target = { index: 2, anchor: 'Reception', line: 'Reception' };
    const live = apiSections([1, 'Background', 'Background'], [4, 'Reception', 'Reception_2']);
    assert.equal(resolveSectionIndex(live, target), 4);
});

test('resolveSectionIndex picks the nearest match when heading text repeats', () => {
    const target = { index: 7, anchor: null, line: 'Notes' };
    const live = apiSections([2, 'Notes', 'Notes'], [8, 'Notes', 'Notes_2'], [14, 'Notes', 'Notes_3']);
    assert.equal(resolveSectionIndex(live, target), 8);
});

test('resolveSectionIndex strips markup from the API line before comparing', () => {
    const target = { index: 3, anchor: 'Nope', line: 'The Times review' };
    const live = apiSections([5, 'The <i>Times</i> review', 'The_Times_review_2']);
    assert.equal(resolveSectionIndex(live, target), 5);
});

test('resolveSectionIndex returns null when the section is gone', () => {
    const target = { index: 4, anchor: 'Reception', line: 'Reception' };
    const live = apiSections([1, 'Background', 'Background'], [2, 'Legacy', 'Legacy']);
    assert.equal(resolveSectionIndex(live, target), null);
});

test('resolveSectionIndex keeps the lead at 0 and ignores transcluded entries', () => {
    assert.equal(resolveSectionIndex(apiSections([1, 'A', 'A']), { index: 0, anchor: null, line: null }), 0);
    const live = [{ index: 'T-1', line: 'Template heading', anchor: 'Template_heading' }, ...apiSections([1, 'Real', 'Real'])];
    assert.equal(resolveSectionIndex(live, { index: 1, anchor: 'Template_heading', line: 'Template heading' }), null);
});

test('resolveSectionIndex tolerates a missing or malformed section list', () => {
    const target = { index: 4, anchor: 'Reception', line: 'Reception' };
    assert.equal(resolveSectionIndex(null, target), null);
    assert.equal(resolveSectionIndex(undefined, target), null);
    assert.equal(resolveSectionIndex(apiSections([1, 'A', 'A']), null), null);
});
