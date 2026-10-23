import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
    splitLeadAndBody, leadParagraphs, leadSentences, markLeadCitations, articleBody,
    isLeadDemotedVerdict, LEAD_BODY_MAX_CHARS,
} from '../core/lead.js';
import { collectCitations } from '../core/citations.js';
import { sentencexSplitSentences } from '../service/sentences.js';

const ref = id => `<sup id="cite_ref-${id}" class="reference mw-ref"><a href="./Test#cite_note-${id}">[${id}]</a></sup>`;
const notes = ids => `<div class="mw-references-wrap"><ol class="references">${ids.map(id =>
    `<li id="cite_note-${id}"><a class="external" href="https://x.example/${id}">s</a></li>`).join('')}</ol></div>`;

// Parsoid REST shape: <section>s, nested by heading level.
const PARSOID = JSDOM.fragment(
    '<section data-mw-section-id="0">'
    + '<div class="shortdescription">Polish physicist</div>'
    + '<table class="infobox"><tr><td><p>Born 7 November 1867.' + ref(9) + '</p></td></tr></table>'
    + '<p>Marie Curie was a physicist and chemist.' + ref(1) + ' She won two Nobel Prizes.</p>'
    + '<p>She founded the Curie Institutes.<sup class="noprint Inline-Template">[citation needed]</sup> '
    + 'Dr. Smith said so. Pierre died in 1906.</p>'
    + '</section>'
    + '<section data-mw-section-id="1"><h2 id="Early_life">Early life</h2>'
    + '<p>Maria was born in Warsaw.' + ref(2) + '</p>'
    + '<section data-mw-section-id="2"><h3 id="Education">Education</h3>'
    + '<p>She studied at the Flying University.</p></section></section>'
    + '<section data-mw-section-id="3"><h2 id="Awards">Awards</h2>'
    + '<table class="wikitable"><tr><th>Year</th><th>Prize</th></tr><tr><td>1903</td><td>Nobel Prize in Physics</td></tr></table>'
    + '<div class="navbox"><p>Nobel laureates navbox</p></div></section>'
    + '<section data-mw-section-id="4"><h2 id="See_also">See also</h2><ul><li>List of Polish physicists</li></ul></section>'
    + '<section data-mw-section-id="5"><h2 id="Notes">Notes</h2>' + notes([1, 2, 9]) + '</section>'
    + '<section data-mw-section-id="6"><h2 id="Further_reading">Further reading</h2><p>Intro to the reading list.</p>'
    + '<div class="refbegin"><ul><li>Quinn, Susan. Marie Curie: A Life.</li></ul></div>'
    + '<section data-mw-section-id="7"><h3 id="Fiction">Fiction</h3><ul><li>A novel about her.</li></ul></section></section>'
    + '<section data-mw-section-id="8"><h2 id="External_links">External links</h2><ul><li>Official site</li></ul></section>'
);

// Browser skin shape: flat children of .mw-parser-output, new and old heading markup.
const SKIN = new JSDOM(
    '<div id="mw-content-text"><div class="mw-parser-output">'
    + '<div role="note" class="hatnote">For other uses, see Curie.</div>'
    + '<p>Marie Curie was a physicist.<sup class="reference"><a href="#cite_note-1">[1]</a></sup> She lived in Paris.</p>'
    + '<div class="mw-heading mw-heading2"><h2 id="Life">Life</h2><span class="mw-editsection">[<a href="#">edit</a>]</span></div>'
    + '<p>She moved to Paris in 1891.</p>'
    + '<h2><span class="mw-headline" id="Legacy">Legacy</span><span class="mw-editsection">[edit]</span></h2>'
    + '<p>The element curium is named after her.</p>'
    + '<div class="mw-heading mw-heading2"><h2 id="Примечания">Примечания</h2></div>'
    + '<div class="reflist"><ol class="references"><li id="cite_note-1">x</li></ol></div>'
    + '</div></div>'
).window.document.getElementById('mw-content-text');

test('Parsoid: the lead is section 0, its prose is the <p>s outside the infobox', () => {
    const { lead, body } = splitLeadAndBody(PARSOID);
    assert.equal(lead.length, 1);
    assert.equal(lead[0].getAttribute('data-mw-section-id'), '0');
    assert.ok(body.length >= 5);
    const paragraphs = leadParagraphs(PARSOID);
    assert.equal(paragraphs.length, 2, 'infobox <p> and short description are not lead prose');
});

test('Parsoid: lead sentences drop footnote markers and maintenance templates, and keep "Dr. Smith" whole', () => {
    assert.deepEqual(leadSentences(PARSOID).map(s => [s.paragraphIndex, s.text]), [
        [0, 'Marie Curie was a physicist and chemist.'],
        [0, 'She won two Nobel Prizes.'],
        [1, 'She founded the Curie Institutes.'],
        [1, 'Dr. Smith said so.'],
        [1, 'Pierre died in 1906.'],
    ]);
    assert.deepEqual(leadSentences(PARSOID).map(s => s.index), [0, 1, 2, 3, 4]);
});

test('lead sentences take an injected splitter, as the batch passes sentencex', () => {
    const texts = leadSentences(PARSOID, { splitSentences: sentencexSplitSentences('en') }).map(s => s.text);
    assert.ok(texts.includes('She won two Nobel Prizes.'));
    assert.ok(texts.includes('Dr. Smith said so.'));
    const halves = leadSentences(PARSOID, { splitSentences: t => [t] }).map(s => s.text);
    assert.equal(halves.length, 2, 'one "sentence" per paragraph with a no-op splitter');
});

test('Parsoid: the body keeps prose, subsections and tables, and never the lead', () => {
    const body = articleBody(PARSOID);
    assert.equal(body.truncated, false);
    assert.deepEqual(body.sections.map(s => [s.level, s.heading]), [
        [2, 'Early life'], [3, 'Education'], [2, 'Awards'],
    ]);
    assert.match(body.text, /^== Early life ==\nMaria was born in Warsaw\.$/m);
    assert.match(body.text, /=== Education ===\nShe studied at the Flying University\./);
    assert.match(body.text, /1903 Nobel Prize in Physics/, 'table text is body text');
    assert.doesNotMatch(body.text, /physicist and chemist/, 'the lead never supports itself');
    assert.doesNotMatch(body.text, /\[\d+\]/, 'no footnote markers');
    assert.doesNotMatch(body.text, /navbox/i);
});

test('appendix sections are dropped by name and by holding a reference list, subsections included', () => {
    const text = articleBody(PARSOID).text;
    for (const gone of ['See also', 'Polish physicists', 'Notes', 'Further reading', 'Intro to the reading list',
        'Quinn', 'Fiction', 'A novel about her', 'External links', 'Official site']) {
        assert.ok(!text.includes(gone), `"${gone}" is not body`);
    }
});

test('a footnote list under a content section, with no heading of its own, does not drop that section', () => {
    const frag = JSDOM.fragment(
        '<section data-mw-section-id="0"><p>A village in Poland.</p></section>'
        + `<section data-mw-section-id="1"><h2>Geography</h2><p>The village has a church.</p>${notes([1])}</section>`
        + '<section data-mw-section-id="2"><h2>Bibliografia polska</h2><p>Lista.</p><div class="refbegin"><ul><li>Kowalski.</li></ul></div></section>'
    );
    assert.deepEqual(articleBody(frag).sections.map(s => [s.heading, s.text]), [['Geography', 'The village has a church.']],
        'the short section survives its trailing {{reflist}}; an unlisted heading holding a bibliography is an appendix');
});

test('browser skin: lead is everything before the first heading; both heading markups start sections', () => {
    assert.deepEqual(leadSentences(SKIN).map(s => s.text), ['Marie Curie was a physicist.', 'She lived in Paris.']);
    const body = articleBody(SKIN);
    assert.deepEqual(body.sections.map(s => s.heading), ['Life', 'Legacy'], 'edit links stripped, Примечания dropped');
    assert.match(body.text, /== Life ==\nShe moved to Paris in 1891\./);
    assert.doesNotMatch(body.text, /edit/);
});

test('an article with no headings has a lead and no body', () => {
    const stub = JSDOM.fragment('<div class="mw-parser-output"><p>A stub about a village.<sup class="reference"><a href="#cite_note-1">[1]</a></sup></p></div>');
    assert.equal(leadSentences(stub).length, 1);
    const body = articleBody(stub);
    assert.equal(body.text, '');
    assert.deepEqual(body.sections, []);
});

test('markLeadCitations: lead prose only, not the infobox or the body', () => {
    const citations = markLeadCitations(collectCitations(PARSOID), PARSOID);
    const byNumber = Object.fromEntries(citations.map(c => [c.citationNumber, c.inLead]));
    assert.deepEqual(byNumber, { 9: false, 1: true, 2: false });
});

test('over the budget, sections are kept by overlap with the lead, in article order, and marked truncated', () => {
    const filler = n => 'unrelated filler words here. '.repeat(n);
    const frag = JSDOM.fragment(
        '<section data-mw-section-id="0"><p>The bridge opened in 1998 over the Morrison river.</p></section>'
        + `<section data-mw-section-id="1"><h2>Geology</h2><p>${filler(40)}</p></section>`
        + '<section data-mw-section-id="2"><h2>History</h2><p>The Morrison bridge opened in 1998.</p></section>'
        + `<section data-mw-section-id="3"><h2>Trivia</h2><p>${filler(40)}</p></section>`
        + '<section data-mw-section-id="4"><h2>Design</h2><p>The river crossing is a bridge.</p></section>'
    );
    const full = articleBody(frag);
    assert.equal(full.truncated, false);
    const leadText = leadSentences(frag).map(s => s.text).join(' ');
    const cut = articleBody(frag, { maxChars: 1300, leadText });
    assert.equal(cut.truncated, true);
    assert.equal(cut.totalChars, full.chars);
    assert.ok(cut.chars <= 1300);
    assert.deepEqual(cut.sections.map(s => s.heading), ['Geology', 'History', 'Design'],
        'the sections naming the lead\'s words are kept first, then kept in article order');
});

test('a single section larger than the budget keeps its start', () => {
    const frag = JSDOM.fragment(
        '<section data-mw-section-id="0"><p>Lead text about something.</p></section>'
        + `<section data-mw-section-id="1"><h2>Everything</h2><p>${'word '.repeat(500)}</p></section>`
    );
    const body = articleBody(frag, { maxChars: 300 });
    assert.equal(body.truncated, true);
    assert.equal(body.sections.length, 1);
    assert.ok(body.chars <= 300);
    assert.match(body.text, /^== Everything ==\nword word/);
});

test('the default body budget matches the Worker\'s source cap', () => {
    assert.equal(LEAD_BODY_MAX_CHARS, 100000);
});

test('isLeadDemotedVerdict: partial and omission are demoted; contradiction and the rest are not', () => {
    assert.equal(isLeadDemotedVerdict('PARTIALLY SUPPORTED', null), true);
    assert.equal(isLeadDemotedVerdict('Partially supported'), true);
    assert.equal(isLeadDemotedVerdict('NOT SUPPORTED', 'omission'), true);
    assert.equal(isLeadDemotedVerdict('NOT SUPPORTED', 'contradiction'), false);
    assert.equal(isLeadDemotedVerdict('NOT SUPPORTED', null), false, 'an unknown reason is reported, not hidden');
    assert.equal(isLeadDemotedVerdict('SUPPORTED'), false);
    assert.equal(isLeadDemotedVerdict('SOURCE UNAVAILABLE'), false);
    assert.equal(isLeadDemotedVerdict('SKIPPED'), false);
    assert.equal(isLeadDemotedVerdict(null), false);
});
