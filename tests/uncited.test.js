import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { uncitedSentences, UNCITED_MAX_SENTENCES, UNCITED_OPENING_MAX_CHARS } from '../core/uncited.js';
import { bodyParagraphs, articleBody } from '../core/lead.js';
import { sentencexSplitSentences } from '../service/sentences.js';

const ref = id => `<sup id="cite_ref-${id}" class="reference mw-ref"><a href="./Test#cite_note-${id}">[${id}]</a></sup>`;
const cn = '<sup class="noprint Inline-Template Template-Fact">[<i><a href="#">citation needed</a></i>]</sup>';

// Parsoid REST shape: <section>s, nested by heading level.
const PARSOID = JSDOM.fragment(
    '<section data-mw-section-id="0">'
    + '<p>Marie Curie was a physicist. She is not checked here: the lead check reads the lead.</p>'
    + '</section>'
    + '<section data-mw-section-id="1"><h2 id="Early_life">Early life</h2>'
    // A citation, then two uncited sentences.
    + '<p>Maria was born in Warsaw.' + ref(2) + ' She was the youngest of five children. Her father taught mathematics.</p>'
    // A paragraph-final citation covers every sentence before it.
    + '<p>She studied at the Flying University. She moved to Paris in 1891.' + ref(3) + '</p>'
    // A citation mid-sentence: that sentence is cited, the next is not.
    + '<p>The school, according to Smith,' + ref(4) + ' was the largest in the city. It closed in 1990.</p>'
    + '<section data-mw-section-id="2"><h3 id="Family">Family</h3>'
    // No citation at all; an abbreviation that must not split; a too-short sentence.
    + '<p>The family lost its property. Dr. Smith wrote about it. He died.</p>'
    // [citation needed] is uncited text, and its marker is not part of it.
    + '<p>She founded the institute.' + cn + ' It opened in 1932.</p>'
    + '<blockquote><p>A quotation is not the article speaking.</p></blockquote>'
    + '<table class="wikitable"><tr><td><p>A table cell paragraph.</p></td></tr></table>'
    + '</section></section>'
    + '<section data-mw-section-id="3"><h2 id="See_also">See also</h2><p>An introduction to the links.</p><ul><li>Pierre Curie</li></ul></section>'
    + '<section data-mw-section-id="4"><h2 id="Further_reading">Further reading</h2><p>Intro to the list.</p>'
    + '<div class="refbegin"><ul><li>Quinn, Susan. Marie Curie: A Life.</li></ul></div></section>'
);

// Browser skin shape: flat children of .mw-parser-output.
const SKIN = new JSDOM(
    '<div id="mw-content-text"><div class="mw-parser-output">'
    + '<p>Marie Curie was a physicist.<sup class="reference"><a href="#cite_note-1">[1]</a></sup> She lived in Paris.</p>'
    + '<div class="mw-heading mw-heading2"><h2 id="Life">Life</h2><span class="mw-editsection">[<a href="#">edit</a>]</span></div>'
    + '<p>She moved to Paris in 1891.<sup class="reference"><a href="#cite_note-2">[2]</a></sup> She met Pierre in 1894.</p>'
    + '<h2><span class="mw-headline" id="Legacy">Legacy</span><span class="mw-editsection">[edit]</span></h2>'
    + '<p>The element curium is named after her.</p>'
    + '<div class="mw-heading mw-heading2"><h2 id="Примечания">Примечания</h2></div>'
    + '<div class="reflist"><ol class="references"><li id="cite_note-1">x</li></ol></div>'
    + '</div></div>'
).window.document.getElementById('mw-content-text');

test('Parsoid: uncited sentences are the ones after the last citation in their paragraph', () => {
    const { sentences } = uncitedSentences(PARSOID);
    assert.deepEqual(sentences.map(s => [s.sectionTitle, s.text]), [
        ['Early life', 'She was the youngest of five children.'],
        ['Early life', 'Her father taught mathematics.'],
        ['Early life', 'It closed in 1990.'],
        ['Family', 'The family lost its property.'],
        ['Family', 'Dr. Smith wrote about it.'],
        ['Family', 'She founded the institute.'],
        ['Family', 'It opened in 1932.'],
    ]);
    assert.deepEqual(sentences.map(s => s.index), [0, 1, 2, 3, 4, 5, 6]);
});

test('a paragraph-final citation covers its whole paragraph, and a mid-sentence one covers its sentence', () => {
    const texts = uncitedSentences(PARSOID).sentences.map(s => s.text);
    assert.ok(!texts.includes('She studied at the Flying University.'), 'cited by the paragraph-final [3]');
    assert.ok(!texts.some(t => t.includes('was the largest in the city')), 'the sentence holding [4] is cited');
    assert.ok(!texts.some(t => /Warsaw/.test(t)));
});

test('the lead, quotations, tables, appendix sections and too-short sentences are left out', () => {
    const texts = uncitedSentences(PARSOID).sentences.map(s => s.text);
    assert.ok(!texts.some(t => /Marie Curie was a physicist/.test(t)), 'the lead check reads the lead');
    assert.ok(!texts.some(t => /quotation|table cell/.test(t)));
    assert.ok(!texts.some(t => /introduction to the links|Intro to the list/.test(t)), 'See also and Further reading are appendices');
    assert.ok(!texts.includes('He died.'), 'shorter than MIN_CLAIM_LENGTH');
    assert.ok(!texts.some(t => /citation needed/.test(t)), 'maintenance markers are not text');
});

test('paragraphs carry their whole text, and each sentence its offset in it', () => {
    const { sentences, paragraphs } = uncitedSentences(PARSOID);
    assert.equal(paragraphs.length, 4, 'only paragraphs with an uncited sentence');
    assert.equal(paragraphs[0].text, 'Maria was born in Warsaw. She was the youngest of five children. Her father taught mathematics.');
    assert.equal(paragraphs[0].block.tagName, 'P');
    for (const s of sentences) {
        assert.ok(paragraphs[s.paragraphIndex].text.slice(s.start).startsWith(s.text), s.text);
        assert.equal(paragraphs[s.paragraphIndex].sectionTitle, s.sectionTitle);
    }
});

test('the opening paragraph goes along as context, capped', () => {
    assert.equal(uncitedSentences(PARSOID).opening,
        'Marie Curie was a physicist. She is not checked here: the lead check reads the lead.');
    const long = JSDOM.fragment(
        `<section data-mw-section-id="0"><p>${'Word '.repeat(400)}</p></section>`
        + '<section data-mw-section-id="1"><h2>Body</h2><p>Something happened in 1900.</p></section>'
    );
    const { opening } = uncitedSentences(long);
    assert.ok(opening.length <= UNCITED_OPENING_MAX_CHARS + 1);
    assert.ok(opening.endsWith('…'));
});

test('browser skin: the body starts at the first heading, and the reference list is not body', () => {
    const result = uncitedSentences(SKIN);
    assert.deepEqual(result.sentences.map(s => [s.sectionTitle, s.text]), [
        ['Life', 'She met Pierre in 1894.'],
        ['Legacy', 'The element curium is named after her.'],
    ]);
    assert.equal(result.usesLead, false);
    assert.equal(result.opening, 'Marie Curie was a physicist. She lived in Paris.');
});

test('an article with no headings has no body and no lead check, so its paragraphs are read here', () => {
    const stub = JSDOM.fragment(
        '<section data-mw-section-id="0">'
        + '<p>The Morrison Bridge opened in 1998.' + ref(1) + ' It is the longest bridge in the state.</p>'
        + '<p>It was designed by Anna Holt.</p></section>'
    );
    assert.equal(articleBody(stub).text, '', 'the lead check sees no body');
    const result = uncitedSentences(stub);
    assert.equal(result.usesLead, true);
    assert.equal(result.opening, '', 'its first paragraph is checked, not repeated as context');
    assert.deepEqual(result.sentences.map(s => [s.sectionTitle, s.text]), [
        [null, 'It is the longest bridge in the state.'],
        [null, 'It was designed by Anna Holt.'],
    ]);
});

test('a fully cited article has nothing to check', () => {
    const cited = JSDOM.fragment(
        '<section data-mw-section-id="0"><p>Lead.</p></section>'
        + '<section data-mw-section-id="1"><h2>History</h2><p>It opened in 1998. It was rebuilt in 2004.' + ref(1) + '</p></section>'
    );
    assert.deepEqual(uncitedSentences(cited), {
        sentences: [], paragraphs: [], opening: 'Lead.', total: 0, capped: false, usesLead: false,
    });
});

test('the sentence cap keeps the first sentences in article order and says so', () => {
    const result = uncitedSentences(PARSOID, { maxSentences: 3 });
    assert.equal(result.sentences.length, 3);
    assert.equal(result.total, 7);
    assert.equal(result.capped, true);
    assert.equal(result.paragraphs.length, 2, 'no paragraph is kept without a sentence');
    assert.equal(uncitedSentences(PARSOID).capped, false);
    assert.ok(UNCITED_MAX_SENTENCES >= 100);
});

test('takes an injected splitter, as the batch passes sentencex', () => {
    const texts = uncitedSentences(PARSOID, { splitSentences: sentencexSplitSentences('en') }).sentences.map(s => s.text);
    assert.ok(texts.includes('Dr. Smith wrote about it.'));
    assert.ok(texts.includes('It closed in 1990.'));
    const whole = uncitedSentences(PARSOID, { splitSentences: t => [t] }).sentences.map(s => s.text);
    assert.deepEqual(whole, [
        'The family lost its property. Dr. Smith wrote about it. He died.',
        'She founded the institute. It opened in 1932.',
    ], 'a paragraph that is one "sentence" is uncited only when it has no citation at all');
});

test('an explanatory note counts as a citation for now (the separate core/citations.js fix)', () => {
    const noted = JSDOM.fragment(
        '<section data-mw-section-id="0"><p>Lead.</p></section>'
        + '<section data-mw-section-id="1"><h2>History</h2><p>It opened in 1998.'
        + '<sup id="cite_ref-a" class="reference"><a href="./Test#cite_note-a">[a]</a></sup></p></section>'
    );
    assert.deepEqual(uncitedSentences(noted).sentences, [],
        'missed, not misreported: the safe direction until notes stop counting as citations');
});

test('bodyParagraphs: section titles from both HTML shapes, no appendices or non-prose blocks', () => {
    assert.deepEqual(bodyParagraphs(PARSOID).map(p => p.sectionTitle),
        ['Early life', 'Early life', 'Early life', 'Family', 'Family']);
    assert.deepEqual(bodyParagraphs(SKIN).map(p => p.sectionTitle), ['Life', 'Legacy']);
    assert.ok(articleBody(PARSOID).sections.every(s => !('paragraphs' in s)), 'the lead check\'s body stays plain data');
});
