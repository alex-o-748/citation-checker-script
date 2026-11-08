import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { LEAD_OUTCOMES } from '../core/lead-check.js';

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');

// The report's cards and the lead check's panel, lifted out of main.js and
// run against the report markup createUI() ships (also lifted out), so
// neither can drift from what is tested. OOUI and the feedback controls are
// stubbed: they have tests of their own.
function extractMethod(src, signature) {
    const start = src.indexOf(`        ${signature}`);
    assert.ok(start !== -1, `method not found in main.js: ${signature}`);
    const end = src.indexOf('\n        }\n', start);
    assert.ok(end !== -1, `end of method not found: ${signature}`);
    return src.slice(start, end + '\n        }\n'.length);
}

function reportMarkup(src) {
    const start = src.indexOf('<div id="verifier-report-view"');
    const endMarker = '<div id="verifier-report-actions"></div>';
    const end = src.indexOf(endMarker, start);
    assert.ok(start !== -1 && end !== -1, 'report view markup not found in createUI()');
    return src.slice(start, end + endMarker.length).replace(/\$\{this\.t\('([^']*)'\)\}/g, '$1') + '</div>';
}

const METHODS = [
    'findingHtml({', 'findingElement(options) {', 'verdictPillHtml(cls, label) {', "findingTagHtml(text, cls = '') {",
    'verdictHeadHtml(result) {', 'citationRefHtml(result) {', 'truncationNoteHtml(result, text) {', 'editSectionButton(refElement) {',
    'setFindingComment(card, text) {', 'toggleFinding(card, open = !card.classList.contains(\'sv-expanded\')) {',
    'isFindingSummaryClick(card, e) {', 'handleFindingClick(e) {', 'revealReportCard(el) {', 'attachRefScrollHandler(el, refElement) {',
    'buildSoloCard(result) {', 'buildGroupBlock(firstResult) {', 'renderGroupCollectiveResult(result) {', 'hideGroupCollectiveSlot(groupId) {',
    'buildGroupRow(result) {', 'quoteViewOf(result) {', 'quoteHtml(view) {', 'verdictClassFor(verdict) {', 'reasonTypeLabel(reasonType) {',
    'resetReportLead() {', 'leadDemotedCards() {', 'renderReportLead() {', 'leadFindings(lead) {', 'leadStatusText(lead) {',
    'leadCheckHtml(lead) {', 'leadFindingCardHtml(r) {', 'escapeHtml(str) {',
];

function harness() {
    const src = fs.readFileSync(MAIN_JS, 'utf8');
    const methods = METHODS.map(sig => extractMethod(src, sig)).join('\n');
    const dom = new JSDOM(`<!DOCTYPE html><body><div id="source-verifier-sidebar">${reportMarkup(src)}</div>`
        + '<p id="article"><sup class="reference"><a id="ref1" href="#n1">[1]</a></sup><sup class="reference"><a id="ref2" href="#n2">[2]</a></sup></p></body>');
    const { window } = dom;
    const scrolled = [];
    window.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.id || this.className); };
    const OO = { ui: { ButtonWidget: function (config) {
        const a = window.document.createElement('a');
        a.className = 'oo-ui-widget oo-ui-buttonElement';
        a.textContent = config.label;
        this.$element = [a];
    } } };
    const deps = { document: window.document, window, OO, CSS: { escape: s => s }, LEAD_OUTCOMES, SKIPPED_VERDICT: 'SKIPPED' };
    const Harness = new Function(...Object.keys(deps), `
        class Harness {
            constructor() { this.reportCardEls = new Map(); this.reportResults = []; this.reportLead = null; this.reportLeadOnly = false; }
            t(en, params = {}) { return en.replace(/\\{(\\w+)\\}/g, (m, k) => (k in params ? String(params[k]) : m)); }
            buildEditUrl() { return '#edit'; }
            clearHighlights() {}
            scrollToLeadSentence(index) { this.scrolledLead = index; }
            buildFeedbackControls(result) {
                if (!result.checkId) return null;
                const el = document.createElement('div');
                el.className = 'verifier-feedback';
                return el;
            }
${methods}
        }
        return Harness;
    `)(...Object.values(deps));
    const h = new Harness();
    const doc = window.document;
    doc.getElementById('verifier-report-view').addEventListener('click', e => h.handleFindingClick(e));
    const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    return { h, doc, click, scrolled };
}

const solo = (extra = {}) => ({
    citationNumber: '1', claimText: 'The bank reported a solvency ratio of 13.8%, above the 12% statutory minimum, as late as 30 September.',
    url: 'https://example.org/s1', verdict: 'NOT SUPPORTED', reason_type: 'omission',
    comments: 'The source is a headline about a rating downgrade.', sourceQuote: 'Rating cut', quoteDisplay: 'Rating cut',
    quoteVerified: true, quoteStatus: 'exact', truncated: true, checkId: 'c1', ...extra,
});

test('a card shows its verdict, claim and comment; the evidence, caveats and actions wait in its details', () => {
    const { h, doc } = harness();
    doc.getElementById('ref1');
    const card = h.buildSoloCard(solo({ refElement: doc.getElementById('ref1') }));
    assert.ok(card.classList.contains('verifier-report-card') && card.classList.contains('verdict-not-supported'), 'the classes the filters and the sort key on');
    const head = card.querySelector(':scope > .sv-finding-head');
    assert.equal(head.querySelector('a.report-card-citation-link').getAttribute('href'), 'https://example.org/s1', '[N] still opens the source');
    assert.deepEqual([...head.querySelectorAll('.report-card-verdict, .sv-finding-tag')].map(e => e.textContent), ['Not Supported', 'Omission']);
    assert.equal(card.querySelector(':scope > .sv-finding-claim').textContent, solo().claimText, 'the whole claim, clamped by CSS, not cut');
    assert.equal(card.querySelector(':scope > .sv-finding-comment').textContent, solo().comments);

    const details = card.querySelector(':scope > .sv-finding-details');
    assert.equal(details.hidden, true);
    assert.deepEqual([...details.children].map(c => c.className), ['sv-quote', 'report-card-truncated', 'sv-finding-actions']);
    assert.deepEqual([...details.querySelector('.sv-finding-actions').children].map(c => c.className), ['report-card-action', 'verifier-feedback']);

    const fine = h.buildSoloCard(solo({ verdict: 'SUPPORTED', reason_type: null, refElement: doc.getElementById('ref1') }));
    assert.equal(fine.querySelector('.report-card-action'), null, 'no Edit section for a supported citation');
    assert.equal(fine.querySelector('.report-card-truncated'), null, 'nor a truncation caveat');
});

test('a click on a closed card opens it and shows its citation; only its head closes it again', () => {
    const { h, doc, click, scrolled } = harness();
    const card = h.buildSoloCard(solo({ refElement: doc.getElementById('ref1') }));
    doc.getElementById('verifier-report-results').appendChild(card);
    const details = card.querySelector('.sv-finding-details');
    const toggle = card.querySelector('.sv-finding-toggle');

    click(card.querySelector('.sv-finding-claim'));
    assert.equal(details.hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(scrolled, ['ref1'], 'opening shows the citation in the article');

    click(card.querySelector('.sv-finding-claim'));
    click(details.querySelector('.sv-quote'));
    assert.equal(details.hidden, false, 'an open card\'s text is for reading and selecting');

    click(card.querySelector('.sv-finding-head'));
    assert.equal(details.hidden, true);
    assert.deepEqual(scrolled, ['ref1'], 'closing leaves the article where it is');

    click(toggle);
    assert.equal(details.hidden, false, 'the toggle button works for the keyboard');
    click(toggle);
    click(card.querySelector('a.report-card-citation-link'));
    assert.equal(details.hidden, true, 'the [N] link opens the source, not the card');
});

test('a group is one card: pending, then its combined verdict in the head; its sources are cards inside it', () => {
    const { h, doc, click } = harness();
    const member = (n, verdict, extra = {}) => solo({ citationNumber: n, groupId: 'g1', groupSize: 2, groupCitationNumbers: ['1', '2'], verdict, refElement: doc.getElementById(`ref${n}`), checkId: `c${n}`, ...extra });
    const results = doc.getElementById('verifier-report-results');
    const group = h.buildGroupBlock(member('1', 'SUPPORTED'));
    results.appendChild(group);
    assert.equal(group.querySelector('.report-card-citation').textContent, '[1][2]');
    assert.equal(group.querySelector('.sv-finding-verdict').textContent, 'Checking combined sources…');
    const rows = group.querySelector('.verifier-report-group-rows');
    rows.appendChild(h.buildGroupRow(member('1', 'SUPPORTED', { reason_type: null })));
    rows.appendChild(h.buildGroupRow(member('2', 'NOT SUPPORTED')));
    assert.equal(rows.querySelector('.sv-finding-claim'), null, 'a source shows no claim line: it is the group\'s');

    h.renderGroupCollectiveResult({ groupId: 'g1', verdict: 'PARTIALLY SUPPORTED', comments: 'One source backs it.', checkId: 'cg' });
    assert.equal(group.dataset.collectiveVerdict, 'partial', 'what the filters hide the group by');
    assert.ok(group.classList.contains('verdict-partial'));
    assert.equal(group.querySelector(':scope > .sv-finding-head .report-card-verdict').textContent, 'Partial');
    assert.equal(group.querySelector(':scope > .sv-finding-comment').textContent, 'One source backs it.');
    const actions = group.querySelector(':scope > .sv-finding-details > .sv-finding-actions');
    assert.deepEqual([...actions.children].map(c => c.className), ['report-card-action', 'verifier-feedback'], 'one Edit section, and feedback on the combined verdict');

    click(group.querySelector('.sv-finding-claim'));
    const second = rows.children[1];
    click(second.querySelector('.sv-finding-head'));
    assert.equal(second.querySelector('.sv-finding-details').hidden, false, 'a source opens on its own');
    assert.equal(group.querySelector(':scope > .sv-finding-details').hidden, false, 'without closing its group');
});

test('a group whose combined check was skipped shows its sources\' verdicts, and tags a set-aside source once', () => {
    const { h, doc } = harness();
    const member = (n, verdict, leadDemoted) => ({ ...solo({ citationNumber: n, verdict, reason_type: null, refElement: doc.getElementById(`ref${n}`) }), groupId: 'g1', groupSize: 2, groupCitationNumbers: ['1', '2'], leadDemoted });
    h.reportResults = [member('1', 'PARTIALLY SUPPORTED', true), member('2', 'SOURCE UNAVAILABLE', false)];
    const group = h.buildGroupBlock(h.reportResults[0]);
    doc.getElementById('verifier-report-results').appendChild(group);
    for (const r of h.reportResults) {
        const row = h.buildGroupRow(r);
        h.reportCardEls.set(r, row);
        group.querySelector('.verifier-report-group-rows').appendChild(row);
    }
    assert.equal(doc.querySelectorAll('.sv-lead-aside-tag').length, 0, 'no tag while the combined verdict may still come');
    h.hideGroupCollectiveSlot('g1');
    assert.equal(group.dataset.collectiveSkipped, 'true');
    // (Not querySelectorAll(':scope > ...'): jsdom's matches nested cards' heads too.)
    assert.deepEqual([...group.querySelector(':scope > .sv-finding-head').querySelectorAll('.report-card-verdict')].map(e => e.textContent), ['Partial', 'Unavailable']);
    const rows = group.querySelectorAll('.verifier-report-group-row');
    assert.equal(rows[0].querySelector('.sv-lead-aside-tag').textContent, 'Set aside: lead');
    assert.equal(rows[1].querySelector('.sv-lead-aside-tag'), null);
    h.hideGroupCollectiveSlot('g1');
    assert.equal(doc.querySelectorAll('.sv-lead-aside-tag').length, 1, 'tagged once');
});

const sentences = [0, 1, 2].map(index => ({ index, text: `Sentence ${index}.` }));

test('the lead check is a one-line panel above the citations: closed in a full report, open when it is all there is', () => {
    const { h, doc } = harness();
    const view = doc.getElementById('verifier-report-view');
    const ids = [...view.children].map(c => c.id);
    assert.ok(ids.indexOf('verifier-report-lead') < ids.indexOf('verifier-report-citations'), 'above, so its results never move the citation cards');

    h.reportLead = { sentences, results: [], state: 'pending' };
    h.resetReportLead();
    const panel = doc.querySelector('#verifier-report-lead details.sv-check');
    assert.equal(panel.open, false);
    assert.equal(panel.querySelector(':scope > summary .sv-check-title').textContent, 'Lead vs body');
    assert.equal(panel.querySelector('.sv-check-status').textContent, 'runs after the citations');

    h.reportLead.state = 'done';
    h.reportLead.results = [
        { index: 0, text: 'Sentence 0.', verdict: 'SUPPORTED', outcome: LEAD_OUTCOMES.COVERED },
        { index: 1, text: 'Sentence 1.', verdict: 'NOT SUPPORTED', outcome: LEAD_OUTCOMES.NOT_COVERED, comments: 'Not in the body.' },
        { index: 2, text: 'Sentence 2.', verdict: 'NOT SUPPORTED', outcome: LEAD_OUTCOMES.CONTRADICTED },
    ];
    h.renderReportLead();
    const status = panel.querySelector('.sv-check-status');
    assert.equal(status.textContent, '1 of 3 sentences covered');
    assert.ok(status.classList.contains('sv-check-flagged'), 'tinted when there is something to open it for');
    assert.equal(panel.open, false, 'results arriving never open it');
    assert.deepEqual([...panel.querySelectorAll('.sv-lead-finding')].map(c => c.dataset.leadIndex), ['1', '2']);

    const leadOnly = harness();
    leadOnly.h.reportLead = { sentences, results: [], state: 'pending' };
    leadOnly.h.reportLeadOnly = true;
    leadOnly.h.resetReportLead();
    assert.equal(leadOnly.doc.querySelector('#verifier-report-lead details.sv-check').open, true);
});

test('a lead card the editor opened stays open as later results re-render the panel', () => {
    const { h, doc, click } = harness();
    h.reportLead = { sentences, results: [{ index: 1, text: 'Sentence 1.', verdict: 'NOT SUPPORTED', outcome: LEAD_OUTCOMES.NOT_COVERED }], state: 'running' };
    h.resetReportLead();
    click(doc.querySelector('.sv-lead-finding .sv-finding-claim'));
    h.reportLead.results.push({ index: 2, text: 'Sentence 2.', verdict: 'NOT SUPPORTED', outcome: LEAD_OUTCOMES.NOT_COVERED });
    h.renderReportLead();
    const cards = [...doc.querySelectorAll('.sv-lead-finding')];
    assert.deepEqual(cards.map(c => c.classList.contains('sv-expanded')), [true, false]);
});

test('a citation clicked in the article opens its card and whatever holds it', () => {
    const { h, doc } = harness();
    h.reportLead = { sentences, results: [], state: 'done' };
    h.resetReportLead();
    const card = h.buildSoloCard(solo({ verdict: 'PARTIALLY SUPPORTED', reason_type: null, refElement: doc.getElementById('ref1') }));
    h.leadDemotedCards().appendChild(card);
    h.renderReportLead();
    h.revealReportCard(card);
    assert.equal(doc.querySelector('#verifier-report-lead details.sv-check').open, true);
    assert.equal(doc.querySelector('.sv-lead-demoted').open, true);
    assert.equal(card.querySelector('.sv-finding-details').hidden, false);
});
