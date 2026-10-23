import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { LEAD_OUTCOMES } from '../core/lead-check.js';
import { leadSentences, articleBody, leadParagraphs, isLeadDemotedVerdict } from '../core/lead.js';
import { mergeReportUnits } from '../core/groups.js';

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');

// Same approach as severity_ui.test.js: main.js is a browser IIFE that needs
// `mw`, so the lead-check methods are lifted out of the source and run
// against jsdom, pinning the shipped code rather than a copy.
function extractMethod(src, signature) {
    const start = src.indexOf(`        ${signature}`);
    assert.ok(start !== -1, `method not found in main.js: ${signature}`);
    const end = src.indexOf('\n        }\n', start);
    assert.ok(end !== -1, `end of method not found: ${signature}`);
    return src.slice(start, end + '\n        }\n'.length);
}

function harness(bodyHtml = '') {
    const src = fs.readFileSync(MAIN_JS, 'utf8');
    const methods = [
        'articleLead() {',
        'isLeadProseRef(refElement) {',
        'isDemotedLeadVerdict(refElement, verdict, reasonType) {',
        'demotesInReport(result) {',
        'getCountedReportUnits() {',
        'getReportUnits() {',
        'leadCheckHtml(lead) {',
        'leadFindingCardHtml(r) {',
        'leadReportLines(format) {',
        'escapeHtml(str) {',
        'escapeWikitableCell(str) {',
    ].map(sig => extractMethod(src, sig)).join('\n');

    const dom = new JSDOM(`<!DOCTYPE html><body><div id="mw-content-text">${bodyHtml}</div></body>`);
    const deps = { LEAD_OUTCOMES, leadSentences, articleBody, leadParagraphs, isLeadDemotedVerdict, mergeReportUnits };
    const Harness = new Function('document', 'console', ...Object.keys(deps), `
        class Harness {
            constructor() { this.leadCheckEnabled = true; this.reportLead = null; this.reportResults = []; this.reportGroupResults = new Map(); }
            t(en, params = {}) { return en.replace(/\\{(\\w+)\\}/g, (m, k) => (k in params ? String(params[k]) : m)); }
${methods}
        }
        return Harness;
    `)(dom.window.document, console, ...Object.values(deps));
    return { h: new Harness(), doc: dom.window.document };
}

const ref = n => `<sup class="reference"><a href="#cite_note-${n}">[${n}]</a></sup>`;
const ARTICLE = '<div class="mw-parser-output">'
    + `<table class="infobox"><tr><td><p>Born 1867.${ref(9)}</p></td></tr></table>`
    + `<p>Marie Curie was a physicist.${ref(1)} She won two Nobel Prizes.</p>`
    + '<div class="mw-heading mw-heading2"><h2 id="Life">Life</h2></div>'
    + `<p>She moved to Paris in 1891.${ref(2)}</p>`
    + '</div>';

test('articleLead reads the lead and body of the page once, and is null for an article with no body', () => {
    const { h } = harness(ARTICLE);
    const lead = h.articleLead();
    assert.deepEqual(lead.sentences.map(s => s.text), ['Marie Curie was a physicist.', 'She won two Nobel Prizes.']);
    assert.equal(lead.body.text, '== Life ==\nShe moved to Paris in 1891.');
    assert.equal(h.articleLead(), lead, 'cached');

    const stub = harness(`<div class="mw-parser-output"><p>A stub with no headings.${ref(1)}</p></div>`).h;
    assert.equal(stub.articleLead(), null);
});

test('a single check is set aside only in lead prose, with the setting on, for a partial or omission verdict', () => {
    const { h, doc } = harness(ARTICLE);
    const [infobox, lead, body] = [...doc.querySelectorAll('.reference a')];
    assert.equal(h.isDemotedLeadVerdict(lead, 'PARTIALLY SUPPORTED'), true);
    assert.equal(h.isDemotedLeadVerdict(lead, 'NOT SUPPORTED', 'omission'), true);
    assert.equal(h.isDemotedLeadVerdict(lead, 'NOT SUPPORTED', 'contradiction'), false);
    assert.equal(h.isDemotedLeadVerdict(infobox, 'PARTIALLY SUPPORTED'), false, 'the infobox is not lead prose');
    assert.equal(h.isDemotedLeadVerdict(body, 'PARTIALLY SUPPORTED'), false);
    h.leadCheckEnabled = false;
    assert.equal(h.isDemotedLeadVerdict(lead, 'PARTIALLY SUPPORTED'), false, 'off with the setting');
});

test('in a report, demotion asks the run\'s lead state, and set-aside units drop out of the counted units', () => {
    const { h } = harness();
    const solo = (n, verdict, inLead, extra = {}) => ({ citationNumber: n, verdict, inLead, groupSize: 1, ...extra });
    h.reportResults = [
        solo('1', 'PARTIALLY SUPPORTED', true),
        solo('2', 'PARTIALLY SUPPORTED', false),
        solo('3', 'NOT SUPPORTED', true, { reason_type: 'contradiction' }),
    ];
    assert.equal(h.demotesInReport(h.reportResults[0]), false, 'no lead check in this run, nothing is demoted');
    h.reportLead = { sentences: [], results: [], state: 'pending' };
    for (const r of h.reportResults) r.leadDemoted = h.demotesInReport(r);
    assert.deepEqual(h.reportResults.map(r => r.leadDemoted), [true, false, false]);
    assert.deepEqual(h.getCountedReportUnits().map(u => u.citationNumber), ['2', '3']);
});

const sentences = [
    { index: 0, text: 'Marie Curie was a physicist.' },
    { index: 1, text: 'She founded <b>an</b> institute.' },
    { index: 2, text: 'She was born in 1868.' },
    { index: 3, text: 'Lost to an error.' },
];
const results = [
    { index: 0, text: sentences[0].text, verdict: 'SUPPORTED', outcome: LEAD_OUTCOMES.COVERED, section: 'Life' },
    { index: 1, text: sentences[1].text, verdict: 'NOT SUPPORTED', reasonType: 'omission', outcome: LEAD_OUTCOMES.NOT_COVERED, comments: 'Not in the body.', quoteText: null },
    { index: 2, text: sentences[2].text, verdict: 'NOT SUPPORTED', reasonType: 'contradiction', outcome: LEAD_OUTCOMES.CONTRADICTED, section: 'Early life', quoteText: 'Maria was born in 1867.', sourceQuote: 'Maria was born in 1867 | x' },
    { index: 3, text: sentences[3].text, verdict: null, outcome: null, error: 'error' },
];

test('the lead section shows its state, a card per finding, and the covered sentences folded away', () => {
    const { h, doc } = harness();
    const render = lead => {
        const el = doc.createElement('div');
        el.innerHTML = h.leadCheckHtml(lead);
        return el;
    };
    assert.match(render({ sentences, results: [], state: 'pending' }).textContent, /checked against the body after the citations/);
    assert.match(render({ sentences, results: results.slice(0, 2), state: 'running' }).textContent, /\(2 of 4 sentences\)/);

    const done = render({ sentences, results, state: 'done', bodyTruncated: true });
    assert.match(done.textContent, /1 of 4 lead sentences are covered in the body\./);
    assert.match(done.textContent, /only the sections closest to the lead were sent/);
    assert.match(done.textContent, /1 lead sentence could not be checked\./);
    const cards = [...done.querySelectorAll('.sv-lead-card')];
    assert.deepEqual(cards.map(c => [c.dataset.leadIndex, c.querySelector('.sv-lead-tag').textContent]), [
        ['1', 'Not covered in the body'],
        ['2', 'Contradicts the body'],
    ]);
    assert.ok(cards[1].classList.contains('sv-lead-contradicted'));
    assert.equal(cards[0].querySelector('.sv-lead-sentence').textContent, 'She founded <b>an</b> institute.', 'escaped, not markup');
    assert.equal(cards[0].querySelector('.sv-quote'), null, 'no located quote, nothing shown');
    assert.equal(cards[1].querySelector('.sv-quote-text').textContent, '“Maria was born in 1867.”', 'the located text, never the raw quote');
    assert.match(cards[1].textContent, /Section: Early life/);
    assert.deepEqual([...done.querySelectorAll('.sv-lead-covered li')].map(li => li.textContent), ['Marie Curie was a physicist. (Life)']);
});

test('the exports list the lead\'s findings, escaped for a wikitable, and count the set-aside citations', () => {
    const { h } = harness();
    h.reportLead = { sentences, results: [...results, { index: 4, text: 'Pipe | in it.', verdict: 'PARTIALLY SUPPORTED', outcome: LEAD_OUTCOMES.NOT_COVERED, comments: 'a {{b}} c' }], state: 'done' };
    h.reportResults = [{ citationNumber: '1', verdict: 'PARTIALLY SUPPORTED', groupSize: 1, leadDemoted: true }];
    const wiki = h.leadReportLines('wikitext');
    assert.match(wiki, /^=== Lead vs body ===\n1 of 4 lead sentences are covered in the body\.\n/);
    assert.match(wiki, /\| She was born in 1868\. \|\| Contradicts the body \|\| ''"Maria was born in 1867\."'' \|\| \n/);
    assert.match(wiki, /\| Pipe &#124; in it\. \|\| Not covered in the body \|\| — \|\| a &#123;&#123;b&#125;&#125; c\n/);
    assert.match(wiki, /1 lead citation was set aside/);
    assert.doesNotMatch(wiki, /Marie Curie was a physicist/, 'covered sentences are not listed');

    const text = h.leadReportLines('plaintext');
    assert.match(text, /Contradicts the body\n {2}Lead sentence: She was born in 1868\.\n {2}Quote: "Maria was born in 1867\."/);

    h.reportLead.state = 'running';
    assert.equal(h.leadReportLines('wikitext'), '', 'nothing until the check has finished');
    h.reportLead = null;
    assert.equal(h.leadReportLines('wikitext'), '');
});
