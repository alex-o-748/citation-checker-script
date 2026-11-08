import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { LEAD_OUTCOMES } from '../core/lead-check.js';

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');

// The report's tabs (Citations / Lead), lifted out of main.js and run against
// the report markup createUI() ships, also lifted out of main.js, so neither
// the methods nor the markup can drift from what is tested.
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

function harness({ uiDir = 'ltr' } = {}) {
    const src = fs.readFileSync(MAIN_JS, 'utf8');
    const methods = [
        'isReportTabbed() {',
        'renderReportTabs() {',
        'leadTabBadge(lead) {',
        'selectReportTab(tab, { focus = false, scroll = true } = {}) {',
        'handleReportTabKey(e) {',
        'revealReportCard(card) {',
    ].map(sig => extractMethod(src, sig)).join('\n');
    const dom = new JSDOM(`<!DOCTYPE html><body>${reportMarkup(src)}</body>`);
    const doc = dom.window.document;
    // The lead panel as resetReportLead() builds it, with one set-aside card.
    doc.getElementById('verifier-report-lead').innerHTML = '<div class="sv-lead-check"><h4>Lead vs body</h4></div>'
        + '<details class="sv-lead-demoted"><summary></summary><div class="sv-lead-demoted-cards"><div class="verifier-report-card" id="aside"></div></div></details>';
    doc.getElementById('verifier-report-results').innerHTML = '<div class="verifier-report-card" id="body-card"></div>';
    const Harness = new Function('document', 'LEAD_OUTCOMES', `
        class Harness {
            constructor() { this.uiDir = ${JSON.stringify(uiDir)}; this.reportLead = null; this.reportLeadOnly = false; this.reportTab = 'citations'; this.reportTabScroll = {}; }
            t(en, params = {}) { return en.replace(/\\{(\\w+)\\}/g, (m, k) => (k in params ? String(params[k]) : m)); }
${methods}
        }
        return Harness;
    `)(doc, LEAD_OUTCOMES);
    return { h: new Harness(), doc };
}

const pendingLead = () => ({ sentences: [{ index: 0 }, { index: 1 }, { index: 2 }], results: [], state: 'pending' });
const result = (index, outcome) => ({ index, outcome, verdict: outcome ? 'X' : null });

function tabState(doc) {
    const tab = name => doc.getElementById(`verifier-tab-${name}`);
    const panel = name => doc.querySelector(`.sv-report-panel[data-tab="${name}"]`);
    return {
        tabbed: doc.getElementById('verifier-report-view').classList.contains('sv-report-tabbed'),
        barHidden: doc.getElementById('verifier-report-tabs').hidden,
        selected: ['citations', 'lead'].filter(n => tab(n).getAttribute('aria-selected') === 'true'),
        focusable: ['citations', 'lead'].filter(n => tab(n).tabIndex === 0),
        shown: ['citations', 'lead'].filter(n => panel(n).classList.contains('sv-report-panel-active')),
        roles: ['citations', 'lead'].map(n => panel(n).getAttribute('role')),
    };
}

test('the citation summary and list are one panel, the lead check another, each named by its tab', () => {
    const { doc } = harness();
    const citations = doc.getElementById('verifier-report-citations');
    assert.ok(citations.contains(doc.getElementById('verifier-report-summary')), 'the filters and the sort are the citations\' own');
    assert.ok(citations.contains(doc.getElementById('verifier-report-results')));
    assert.equal(doc.getElementById('verifier-tab-citations').getAttribute('aria-controls'), 'verifier-report-citations');
    assert.equal(doc.getElementById('verifier-tab-lead').getAttribute('aria-controls'), 'verifier-report-lead');
    assert.ok(!citations.contains(doc.getElementById('verifier-report-progress')), 'progress is the whole run\'s, outside the tabs');
    assert.ok(!citations.contains(doc.getElementById('verifier-report-actions')), 'so are the exports');
});

test('with the lead check beside the citations, the report has two tabs and shows one panel at a time', () => {
    const { h, doc } = harness();
    h.reportLead = pendingLead();
    h.renderReportTabs();
    assert.deepEqual(tabState(doc), {
        tabbed: true, barHidden: false, selected: ['citations'], focusable: ['citations'], shown: ['citations'], roles: ['tabpanel', 'tabpanel'],
    });
    h.selectReportTab('lead');
    assert.deepEqual(tabState(doc).selected, ['lead']);
    assert.deepEqual(tabState(doc).shown, ['lead']);
    assert.deepEqual(tabState(doc).focusable, ['lead'], 'only the selected tab is in the tab order');
});

test('a report holding one check has no tabs, and shows both panels (the other is empty)', () => {
    const noLead = harness();
    noLead.h.renderReportTabs();
    assert.deepEqual(tabState(noLead.doc), {
        tabbed: false, barHidden: true, selected: [], focusable: [], shown: ['citations', 'lead'], roles: [null, null],
    });
    noLead.h.selectReportTab('lead');
    assert.equal(noLead.h.reportTab, 'citations', 'nothing to switch to');

    const leadOnly = harness();
    leadOnly.h.reportLead = pendingLead();
    leadOnly.h.reportLeadOnly = true;
    leadOnly.h.reportTab = 'lead';
    leadOnly.h.renderReportTabs();
    assert.equal(tabState(leadOnly.doc).barHidden, true);
    assert.deepEqual(tabState(leadOnly.doc).shown, ['citations', 'lead']);
});

test('the Lead tab\'s badge counts the sentences with a finding, so the tab says from afar whether to open it', () => {
    const { h, doc } = harness();
    const badge = () => doc.querySelector('#verifier-tab-lead .sv-report-tab-badge');
    h.reportLead = pendingLead();
    assert.equal(h.leadTabBadge(h.reportLead), null, 'not run yet');

    h.reportLead.state = 'running';
    assert.equal(h.leadTabBadge(h.reportLead).text, '…');
    h.reportLead.results = [result(0, LEAD_OUTCOMES.NOT_COVERED)];
    assert.deepEqual(h.leadTabBadge(h.reportLead), { text: '1', kind: 'not-covered', title: '1 lead sentence is not covered in the body, or contradicts it' });

    h.reportLead.state = 'done';
    h.reportLead.results = [result(0, LEAD_OUTCOMES.NOT_COVERED), result(1, LEAD_OUTCOMES.CONTRADICTED), result(2, LEAD_OUTCOMES.COVERED)];
    h.renderReportTabs();
    assert.equal(badge().textContent, '2');
    assert.ok(badge().classList.contains('sv-report-tab-badge-contradicted'), 'a contradiction outranks a gap');
    assert.equal(doc.getElementById('verifier-tab-lead').title, '2 lead sentences are not covered in the body, or contradict it');

    h.reportLead.results = [result(0, LEAD_OUTCOMES.COVERED), result(1, null)];
    h.renderReportTabs();
    assert.equal(badge().textContent, '', 'nothing found: no badge, not a 0');
    assert.equal(doc.getElementById('verifier-tab-lead').hasAttribute('title'), false);

    h.reportLead = { ...pendingLead(), state: 'stopped' };
    assert.equal(h.leadTabBadge(h.reportLead), null);
});

test('arrow keys move between tabs, mirrored in a right-to-left sidebar; Home and End go to the ends', () => {
    const key = k => ({ key: k, preventDefault() { this.prevented = true; } });
    const ltr = harness();
    ltr.h.reportLead = pendingLead();
    ltr.h.renderReportTabs();
    ltr.h.handleReportTabKey(key('ArrowRight'));
    assert.equal(ltr.h.reportTab, 'lead');
    ltr.h.handleReportTabKey(key('ArrowRight'));
    assert.equal(ltr.h.reportTab, 'citations', 'wraps');
    ltr.h.handleReportTabKey(key('End'));
    assert.equal(ltr.h.reportTab, 'lead');
    ltr.h.handleReportTabKey(key('Home'));
    assert.equal(ltr.h.reportTab, 'citations');
    const other = key('Enter');
    ltr.h.handleReportTabKey(other);
    assert.equal(other.prevented, undefined, 'other keys are left alone');

    const rtl = harness({ uiDir: 'rtl' });
    rtl.h.reportLead = pendingLead();
    rtl.h.renderReportTabs();
    rtl.h.handleReportTabKey(key('ArrowLeft'));
    assert.equal(rtl.h.reportTab, 'lead', 'in RTL the next tab is to the left');
});

test('a card asked for from outside its tab (a citation clicked in the article) opens that tab, and the set-aside group', () => {
    const { h, doc } = harness();
    h.reportLead = pendingLead();
    h.renderReportTabs();
    const group = doc.querySelector('.sv-lead-demoted');
    h.revealReportCard(doc.getElementById('aside'));
    assert.equal(h.reportTab, 'lead');
    assert.equal(group.open, true);
    h.revealReportCard(doc.getElementById('body-card'));
    assert.equal(h.reportTab, 'citations');
    assert.deepEqual(tabState(doc).shown, ['citations']);
});
