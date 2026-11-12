import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { LEAD_OUTCOMES } from '../core/lead-check.js';
import { mergeReportUnits } from '../core/groups.js';
import { claimBounds, textNodesBetween } from '../core/claim.js';

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');

// The report view (its bar, sections and rows), lifted out of main.js and run
// against the report markup createUI() ships (also lifted out), so neither
// can drift from what is tested. The feedback controls are stubbed: they have
// tests of their own.
function extractMethod(src, signature) {
    const start = src.indexOf(`        ${signature}`);
    assert.ok(start !== -1, `method not found in main.js: ${signature}`);
    const end = src.indexOf('\n        }\n', start);
    assert.ok(end !== -1, `end of method not found: ${signature}`);
    return src.slice(start, end + '\n        }\n'.length);
}

function reportMarkup(src) {
    const start = src.indexOf('<div id="verifier-report-view"');
    const endMarker = '<div id="verifier-report-meta"></div>';
    const end = src.indexOf(endMarker, start);
    assert.ok(start !== -1 && end !== -1, 'report view markup not found in createUI()');
    return src.slice(start, end + endMarker.length).replace(/\$\{this\.t\('([^']*)'\)\}/g, '$1') + '</div>';
}

const METHODS = [
    'findingHtml({', 'findingElement(options) {', 'verdictLabelHtml(label) {', "findingTagHtml(text, cls = '') {",
    'verdictHeadHtml(result) {', 'citationRefHtml(result) {', 'truncationNoteHtml(result, text) {',
    'appendFindingLinks(row, { editRef = null, url = null } = {}) {', 'sourceHost(url) {', 'appendFindingFeedback(row, result) {',
    'setFindingComment(card, text) {', 'toggleFinding(card, open = !card.classList.contains(\'sv-expanded\')) {',
    'isFindingSummaryClick(card, e) {', 'handleFindingClick(e) {', 'revealReportCard(el) {', 'attachRefScrollHandler(el, refElement, claimText) {', 'showClaimInArticle(refElement, claimText) {',
    'highlightClaim(refElement, claim) {', 'textRange(nodes, text) {', 'paintHighlight(range) {', 'highlightBlock(block) {',
    'buildSoloCard(result) {', 'buildGroupBlock(firstResult) {', 'renderGroupCollectiveResult(result) {', 'hideGroupCollectiveSlot(groupId) {',
    'buildGroupRow(result) {', 'quoteViewOf(result) {', 'quoteHtml(view) {', 'verdictClassFor(verdict) {', 'reasonTypeLabel(reasonType) {',
    'resetReportLead() {', 'leadDemotedCards() {', 'renderReportLead() {', 'leadFindings(lead) {', 'leadStatusText(lead) {',
    'leadCheckHtml(lead) {', 'leadFindingCardHtml(r) {', 'escapeHtml(str) {',
    'updateReportProgress(current, total, phase, startTime) {', 'renderReportBar() {', 'formatDuration(ms) {',
    'renderReportSummary() {', 'renderReportMeta() {', 'reportSortHtml() {', 'getCountedReportUnits() {', 'getReportUnits() {',
];

function harness() {
    const src = fs.readFileSync(MAIN_JS, 'utf8');
    const methods = METHODS.map(sig => extractMethod(src, sig)).join('\n');
    const dom = new JSDOM(`<!DOCTYPE html><body><div id="source-verifier-sidebar">${reportMarkup(src)}</div>`
        + '<p id="article">Earlier claim.<sup class="reference"><a id="ref0" href="#n0">[0]</a></sup> The bank reported a solvency ratio of  13.8%, above the 12% statutory minimum, as late as 30 September.'
        + '<sup class="reference"><a id="ref1" href="#n1">[1]</a></sup><sup class="reference"><a id="ref2" href="#n2">[2]</a></sup></p></body>');
    const { window } = dom;
    window.Highlight = function (range) { this.range = range; };
    const scrolled = [];
    window.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.id || this.className); };
    const painted = [];
    const deps = { document: window.document, window, URL: window.URL, CSS: { escape: s => s, highlights: { set: (name, h) => painted.push([name, h.range.toString()]), delete() {} } }, LEAD_OUTCOMES, SKIPPED_VERDICT: 'SKIPPED', mergeReportUnits, claimBounds, textNodesBetween, Highlight: window.Highlight };
    const Harness = new Function(...Object.keys(deps), `
        class Harness {
            constructor() {
                this.reportCardEls = new Map(); this.reportResults = []; this.reportGroupResults = new Map();
                this.reportLead = null; this.reportLeadOnly = false; this.reportRunning = false; this.reportCancelled = false;
                this.reportStopped = null; this.reportDurationMs = 0; this.reportSeverity = false; this.reportSort = 'document';
                this.reportFilters = { supported: true }; this.reportTokenUsage = { input: 0, output: 0 }; this.reportRevisionId = null;
            }
            t(en, params = {}) { return en.replace(/\\{(\\w+)\\}/g, (m, k) => (k in params ? String(params[k]) : m)); }
            buildEditUrl() { return 'https://wiki.example/edit'; }
            getRevisionPermalinkUrl(id) { return 'https://wiki.example/rev/' + id; }
            clearHighlights() { this.highlighted = null; document.querySelectorAll('.claim-highlight').forEach(el => el.classList.remove('claim-highlight')); }
            scrollToLeadSentence(index) { this.scrolledLead = index; }
            toggleReportFilter() {}
            setReportSort() {}
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
    return { h, doc, click, scrolled, painted, window };
}

const solo = (extra = {}) => ({
    citationNumber: '1', claimText: 'The bank reported a solvency ratio of 13.8%, above the 12% statutory minimum, as late as 30 September.',
    url: 'https://www.example.org/s1', verdict: 'NOT SUPPORTED', reason_type: 'omission',
    comments: 'The source is a headline about a rating downgrade.', sourceQuote: 'Rating cut', quoteDisplay: 'Rating cut',
    quoteVerified: true, quoteStatus: 'exact', truncated: true, checkId: 'c1', ...extra,
});
// The row's own head line: jsdom's querySelectorAll(':scope > ...') also matches nested rows' heads.
const headOf = row => row.querySelector(':scope > .sv-finding-head');
const texts = (el, selector) => [...el.querySelectorAll(selector)].map(e => e.textContent);

// --- Rows ---

test('a closed row is a head line, the claim and the comment; the evidence, caveats and links wait in its details', () => {
    const { h, doc } = harness();
    const row = h.buildSoloCard(solo({ refElement: doc.getElementById('ref1') }));
    assert.ok(row.classList.contains('verifier-report-card') && row.classList.contains('verdict-not-supported'), 'the classes the filters, the sort and the stripe key on');
    const head = headOf(row);
    assert.equal(head.querySelector('.sv-finding-ref').textContent, '[1]');
    assert.equal(head.querySelector('a'), null, 'the head is text: the source link is in the details');
    assert.deepEqual(texts(head, '.sv-verdict, .sv-finding-tag'), ['Not Supported', 'Omission']);
    assert.equal(row.querySelector(':scope > .sv-finding-claim').textContent, solo().claimText, 'the whole claim, clamped by CSS, not cut');
    assert.equal(row.querySelector(':scope > .sv-finding-comment').textContent, solo().comments);

    const details = row.querySelector(':scope > .sv-finding-details');
    assert.equal(details.hidden, true);
    assert.deepEqual([...details.children].map(c => c.className), ['sv-quote', 'sv-finding-note', 'sv-finding-actions']);
    const links = [...details.querySelectorAll('.sv-finding-links a')];
    assert.deepEqual(links.map(a => [a.textContent, a.getAttribute('href')]), [
        ['Edit section', 'https://wiki.example/edit'],
        ['example.org ↗', 'https://www.example.org/s1'],
    ], 'the source is named by its host');
    assert.ok(details.querySelector('.sv-finding-actions > .verifier-feedback'));

    const fine = h.buildSoloCard(solo({ verdict: 'SUPPORTED', reason_type: null, refElement: doc.getElementById('ref1') }));
    assert.deepEqual(texts(fine, '.sv-finding-links a'), ['example.org ↗'], 'no Edit section for a supported citation');
    assert.equal(fine.querySelector('.sv-finding-note'), null, 'nor a truncation caveat');
});

test('a click on a closed row opens it and shows its citation; only its head closes it again', () => {
    const { h, doc, click, scrolled } = harness();
    const row = h.buildSoloCard(solo({ refElement: doc.getElementById('ref1') }));
    doc.getElementById('verifier-report-results').appendChild(row);
    const details = row.querySelector('.sv-finding-details');
    const toggle = row.querySelector('.sv-finding-toggle');

    click(row.querySelector('.sv-finding-claim'));
    assert.equal(details.hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(scrolled, ['ref1'], 'opening shows the citation in the article');

    click(row.querySelector('.sv-finding-claim'));
    click(details.querySelector('.sv-quote'));
    click(details.querySelector('.sv-finding-links a'));
    assert.equal(details.hidden, false, 'an open row\'s text is for reading, selecting and following');

    click(row.querySelector('.sv-finding-headline'));
    assert.equal(details.hidden, true);
    assert.deepEqual(scrolled, ['ref1'], 'closing leaves the article where it is');

    click(toggle);
    assert.equal(details.hidden, false, 'the toggle button works for the keyboard');
});

test('a group is one row: pending, then its combined verdict in the head; its sources are rows inside it', () => {
    const { h, doc, click } = harness();
    const member = (n, verdict, extra = {}) => solo({ citationNumber: n, groupId: 'g1', groupSize: 2, groupCitationNumbers: ['1', '2'], verdict, refElement: doc.getElementById(`ref${n}`), checkId: `c${n}`, ...extra });
    const results = doc.getElementById('verifier-report-results');
    const group = h.buildGroupBlock(member('1', 'SUPPORTED'));
    results.appendChild(group);
    assert.equal(headOf(group).querySelector('.sv-finding-ref').textContent, '[1][2]');
    assert.equal(headOf(group).querySelector('.sv-finding-verdict').textContent, 'Checking combined sources…');
    const rows = group.querySelector('.verifier-report-group-rows');
    rows.appendChild(h.buildGroupRow(member('1', 'SUPPORTED', { reason_type: null })));
    rows.appendChild(h.buildGroupRow(member('2', 'NOT SUPPORTED')));
    assert.equal(rows.querySelector('.sv-finding-claim'), null, 'a source shows no claim line: it is the group\'s');

    h.renderGroupCollectiveResult({ groupId: 'g1', verdict: 'PARTIALLY SUPPORTED', comments: 'One source backs it.', checkId: 'cg' });
    assert.equal(group.dataset.collectiveVerdict, 'partial', 'what the filters hide the group by');
    assert.ok(group.classList.contains('verdict-partial'), 'and its stripe');
    assert.deepEqual(texts(headOf(group), '.sv-verdict'), ['Partial']);
    assert.equal(group.querySelector(':scope > .sv-finding-comment').textContent, 'One source backs it.');
    const actions = group.querySelector(':scope > .sv-finding-details > .sv-finding-actions');
    assert.deepEqual(texts(actions, '.sv-finding-links a'), ['Edit section'], 'one Edit section for the group');
    assert.ok(actions.querySelector(':scope > .verifier-feedback'), 'feedback on the combined verdict');

    click(group.querySelector('.sv-finding-claim'));
    const second = rows.children[1];
    click(headOf(second).querySelector('.sv-finding-headline'));
    assert.equal(second.querySelector('.sv-finding-details').hidden, false, 'a source opens on its own');
    assert.equal(group.querySelector(':scope > .sv-finding-details').hidden, false, 'without closing its group');
    assert.deepEqual(texts(second, '.sv-finding-links a'), ['example.org ↗']);
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
    assert.deepEqual(texts(headOf(group), '.sv-verdict'), ['Partial', 'Unavailable']);
    const rows = group.querySelectorAll('.verifier-report-group-row');
    assert.equal(rows[0].querySelector('.sv-lead-aside-tag').textContent, 'Set aside: lead');
    assert.equal(rows[1].querySelector('.sv-lead-aside-tag'), null);
    h.hideGroupCollectiveSlot('g1');
    assert.equal(doc.querySelectorAll('.sv-lead-aside-tag').length, 1, 'tagged once');
});

// --- Sections ---

const sentences = [0, 1, 2].map(index => ({ index, text: `Sentence ${index}.` }));
const leadDone = () => ({
    sentences, state: 'done', results: [
        { index: 0, text: 'Sentence 0.', verdict: 'SUPPORTED', outcome: LEAD_OUTCOMES.COVERED },
        { index: 1, text: 'Sentence 1.', verdict: 'NOT SUPPORTED', outcome: LEAD_OUTCOMES.NOT_COVERED, comments: 'Not in the body.' },
        { index: 2, text: 'Sentence 2.', verdict: 'NOT SUPPORTED', outcome: LEAD_OUTCOMES.CONTRADICTED },
    ],
});

test('every check is a section of the same shape: a header with a chevron, a name and a status, that opens and closes', () => {
    const { h, doc } = harness();
    h.reportLead = { sentences, results: [], state: 'pending' };
    h.resetReportLead();
    const lead = doc.querySelector('#verifier-report-lead > details');
    const citations = doc.getElementById('verifier-report-citations');
    const shape = section => [section.tagName, section.className, ...[...section.querySelector(':scope > summary').children].map(c => c.className)];
    assert.deepEqual(shape(lead), ['DETAILS', 'sv-section', 'sv-chevron', 'sv-section-title', 'sv-section-status']);
    assert.deepEqual(shape(citations), shape(lead), 'the citations are a section like the lead check');
    assert.equal(lead.querySelector('.sv-section-title').textContent, 'Lead vs body');
    assert.equal(citations.querySelector('.sv-section-title').textContent, 'Citations');

    const ids = [...doc.getElementById('verifier-report-view').children].map(c => c.id);
    assert.ok(ids.indexOf('verifier-report-lead') < ids.indexOf('verifier-report-citations'), 'the lead comes first, as in the article');
    assert.equal(lead.open, false, 'closed, so its results arriving never move the citation rows');
    assert.equal(citations.open, true);
    assert.equal(lead.querySelector('.sv-section-status').textContent, 'runs after the citations');

    h.reportLead = leadDone();
    h.renderReportLead();
    assert.equal(lead.querySelector('.sv-section-status').textContent, '1 of 3 sentences covered');
    assert.equal(lead.open, false, 'results arriving never open it');
    assert.deepEqual([...lead.querySelectorAll('.sv-lead-finding')].map(c => c.dataset.leadIndex), ['1', '2']);

    const leadOnly = harness();
    leadOnly.h.reportLead = { sentences, results: [], state: 'pending' };
    leadOnly.h.reportLeadOnly = true;
    leadOnly.h.resetReportLead();
    assert.equal(leadOnly.doc.querySelector('#verifier-report-lead > details').open, true, 'open when it is all there is');
});

test('a lead row the editor opened stays open as later results re-render the section, and so does the covered list', () => {
    const { h, doc, click } = harness();
    h.reportLead = { sentences, state: 'running', results: [
        { index: 0, text: 'Sentence 0.', verdict: 'SUPPORTED', outcome: LEAD_OUTCOMES.COVERED },
        { index: 1, text: 'Sentence 1.', verdict: 'NOT SUPPORTED', outcome: LEAD_OUTCOMES.NOT_COVERED },
    ] };
    h.resetReportLead();
    click(doc.querySelector('.sv-lead-finding .sv-finding-claim'));
    assert.equal(h.scrolledLead, 1, 'opening a lead row shows its sentence in the article');
    doc.querySelector('.sv-lead-covered').open = true;
    h.reportLead.results.push({ index: 2, text: 'Sentence 2.', verdict: 'NOT SUPPORTED', outcome: LEAD_OUTCOMES.NOT_COVERED });
    h.renderReportLead();
    assert.deepEqual([...doc.querySelectorAll('.sv-lead-finding')].map(c => c.classList.contains('sv-expanded')), [true, false]);
    assert.equal(doc.querySelector('.sv-lead-covered').open, true);
});

test('a citation clicked in the article opens its row and whatever holds it', () => {
    const { h, doc } = harness();
    h.reportLead = { sentences, results: [], state: 'done' };
    h.resetReportLead();
    const row = h.buildSoloCard(solo({ verdict: 'PARTIALLY SUPPORTED', reason_type: null, refElement: doc.getElementById('ref1') }));
    h.leadDemotedCards().appendChild(row);
    h.renderReportLead();
    assert.equal(doc.querySelector('.sv-lead-demoted .sv-sublist-title').textContent, '1 lead citation set aside');
    h.revealReportCard(row);
    assert.equal(doc.querySelector('#verifier-report-lead > details').open, true);
    assert.equal(doc.querySelector('.sv-lead-demoted').open, true);
    assert.equal(row.querySelector('.sv-finding-details').hidden, false);
});

// --- The bar and the totals ---

test('the report view holds no run buttons: its bar stops a run, then leads back and copies the report', () => {
    const { h, doc } = harness();
    const view = doc.getElementById('verifier-report-view');
    assert.deepEqual([...doc.getElementById('verifier-report-bar').children].map(c => c.id),
        ['verifier-report-back', 'verifier-report-phase', 'verifier-report-stop', 'verifier-report-copy']);
    assert.deepEqual(texts(doc.getElementById('verifier-report-copy'), '[data-format]'), ['Wikitext', 'Plain text']);
    assert.doesNotMatch(view.textContent, /Verify All Citations|Check the lead/, 'those are in the main view, one Back away');

    h.reportRunning = true;
    h.renderReportBar();
    assert.ok(view.classList.contains('sv-running'), 'the stylesheet shows the status line and Stop, and hides Back and Copy');
    h.updateReportProgress(12, 48, 'Checking citation [13]', Date.now() - 12000);
    assert.match(doc.getElementById('verifier-report-phase').textContent, /^Checking citation \[13\] \(12\/48\) · ~\d+s remaining$/);
    assert.equal(doc.querySelector('#verifier-report-progress .verifier-progress-fill').style.width, '25%');

    h.reportCancelled = true;
    h.renderReportBar();
    assert.equal(doc.getElementById('verifier-report-stop').disabled, true, 'a Stop that was heard says so');

    h.reportRunning = false;
    h.reportCancelled = false;
    doc.getElementById('verifier-report-copy').open = true;
    h.renderReportBar();
    assert.equal(view.classList.contains('sv-running'), false);
    assert.equal(doc.getElementById('verifier-report-copy').open, false);
});

test('totals are said once: the section\'s status, the chips, a note for hidden rows, and the run\'s facts in the footer', () => {
    const { h, doc } = harness();
    const unit = (n, verdict, extra = {}) => ({ citationNumber: String(n), verdict, groupSize: 1, ...extra });
    h.reportResults = [unit(1, 'SUPPORTED'), unit(2, 'SUPPORTED'), unit(3, 'PARTIALLY SUPPORTED'), unit(4, 'NOT SUPPORTED'), unit(5, 'NOT SUPPORTED'),
        unit(6, 'PARTIALLY SUPPORTED', { leadDemoted: true })];
    h.reportRevisionId = 123;
    h.reportTokenUsage = { input: 1000, output: 200 };
    h.reportDurationMs = 65000;
    h.renderReportSummary();

    const status = doc.querySelector('#verifier-report-citations .sv-section-status');
    assert.equal(status.textContent, '5 citations checked', 'set-aside lead citations are the lead section\'s to count');
    const chips = [...doc.querySelectorAll('#verifier-report-summary .verifier-filter-chip')];
    assert.deepEqual(chips.map(c => c.textContent.trim()), ['2 supported', '1 partial', '2 not supported'], 'no chip for a verdict the report has none of');
    assert.deepEqual(chips.map(c => c.classList.contains('verifier-chip-off')), [true, false, false], 'a filtered-out verdict\'s chip is hollow');
    assert.ok(chips[0].querySelector('.sv-dot.sv-dot-supported'));
    assert.equal(doc.getElementById('verifier-report-hidden-note').textContent, '2 hidden by filter');
    assert.equal(doc.querySelector('#verifier-report-summary .verifier-sort'), null, 'no order to choose unless the report was ranked');
    assert.equal(doc.getElementById('verifier-report-meta').textContent, 'Revision: 123 · 1,000 input + 200 output tokens · 1m 5s');
    assert.doesNotMatch(doc.getElementById('verifier-report-view').textContent, /Completed/, 'no second line of totals');

    h.reportSeverity = true;
    h.reportSort = 'severity';
    h.reportStopped = { done: 5, total: 20 };
    h.renderReportSummary();
    assert.equal(status.textContent, 'Cancelled after 5 of 20 citations');
    const sort = [...doc.querySelectorAll('#verifier-report-summary .verifier-sort-option')];
    assert.deepEqual(sort.map(b => [b.tagName, b.textContent, b.getAttribute('aria-pressed')]), [
        ['BUTTON', 'Article order', 'false'],
        ['BUTTON', 'Most serious first', 'true'],
    ], 'the order is two pills, like the chips');
    assert.ok(sort[1].classList.contains('sv-chip-selected'));
});

// --- Highlighting the claim, and one open row ---

test('opening a row highlights exactly its claim in the article, the same words extractClaimText() reads', () => {
    const { h, doc, click, painted } = harness();
    const row = h.buildSoloCard(solo({ refElement: doc.getElementById('ref1') }));
    doc.getElementById('verifier-report-results').appendChild(row);
    click(row.querySelector('.sv-finding-claim'));
    assert.deepEqual(painted, [['sv-claim', 'The bank reported a solvency ratio of  13.8%, above the 12% statutory minimum, as late as 30 September.']],
        'from the previous citation to this one, and not the earlier claim');

    // Sentence scope: the claim is only the last sentence, and only it is painted.
    const range = h.textRange(textNodesBetween(...Object.values(claimBounds(doc.getElementById('ref1')))), 'as late as 30 September.');
    assert.equal(range.toString(), 'as late as 30 September.');
    assert.equal(h.textRange([doc.getElementById('article').firstChild], 'Not in the page'), null);
});

test('a claim that cannot be found in the page highlights its paragraph instead', () => {
    const { h, doc, painted } = harness();
    h.highlightClaim(doc.getElementById('ref1'), 'Words the page does not have');
    assert.deepEqual(painted, []);
    assert.ok(doc.getElementById('article').classList.contains('claim-highlight'));
});

test('one row is open at a time; opening a group\'s source keeps its group open', () => {
    const { h, doc, click } = harness();
    const results = doc.getElementById('verifier-report-results');
    const a = h.buildSoloCard(solo({ citationNumber: '1', refElement: doc.getElementById('ref1') }));
    const b = h.buildSoloCard(solo({ citationNumber: '2', refElement: doc.getElementById('ref2') }));
    const member = n => solo({ citationNumber: n, groupId: 'g1', groupSize: 2, groupCitationNumbers: ['1', '2'], refElement: doc.getElementById(`ref${n}`) });
    const group = h.buildGroupBlock(member('1'));
    const source = h.buildGroupRow(member('2'));
    group.querySelector('.verifier-report-group-rows').appendChild(source);
    results.append(a, b, group);
    const open = () => [a, b, group, source].map(r => r.classList.contains('sv-expanded'));

    click(a.querySelector('.sv-finding-claim'));
    click(b.querySelector('.sv-finding-claim'));
    assert.deepEqual(open(), [false, true, false, false], 'opening b closed a');
    click(group.querySelector(':scope > .sv-finding-claim'));
    click(headOf(source).querySelector('.sv-finding-headline'));
    assert.deepEqual(open(), [false, false, true, true], 'the group stays open around its source');
    click(a.querySelector('.sv-finding-claim'));
    assert.deepEqual(open(), [true, false, false, false]);
});
