import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { uncitedSentences } from '../core/uncited.js';
import {
    runUncitedCheck, generateUncitedSystemPrompt, withUncitedCommentLanguage, uncitedChunkSize, uncitedModelFor,
} from '../core/uncited-check.js';
import { QUOTE_STATUSES } from '../core/quote.js';
import { groupMaxTokens } from '../core/providers.js';
import { PROVIDERS } from '../core/models.js';

const LIFTWING = { provider: 'liftwing', model: PROVIDERS.liftwing.model, name: PROVIDERS.liftwing.name };

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');
const SRC = fs.readFileSync(MAIN_JS, 'utf8');

// Same approach as lead_ui.test.js: main.js is a browser IIFE that needs
// `mw`, so the uncited-check methods are lifted out of the source and run
// against jsdom, pinning the shipped code rather than a copy.
function extractMethod(signature) {
    const start = SRC.indexOf(`        ${signature}`);
    assert.ok(start !== -1, `method not found in main.js: ${signature}`);
    const end = SRC.indexOf('\n        }\n', start);
    assert.ok(end !== -1, `end of method not found: ${signature}`);
    return SRC.slice(start, end + '\n        }\n'.length);
}

function harness(bodyHtml = '', { callProviderAPI = async () => { throw new Error('no model in this test'); }, storage = {} } = {}) {
    const methods = [
        'articleUncited() {',
        'uncitedModel() {',
        'apiKeyFor(providerId) {',
        'resetReportUncited() {',
        'renderReportUncited() {',
        'uncitedStatusText(uncited) {',
        'uncitedCheckHtml(uncited) {',
        'uncitedFindingHtml(f) {',
        'uncitedCountsText(uncited) {',
        'uncitedReadListHtml(uncited) {',
        'logUncitedRun(uncited, callLog) {',
        'async runReportUncitedCheck(startTime) {',
        'findingHtml({',
        'verdictLabelHtml(label) {',
        'toggleFinding(card, open = !card.classList.contains(\'sv-expanded\')) {',
        'escapeHtml(str) {',
    ].map(extractMethod).join('\n');

    // The run's console log, kept for the test rather than printed.
    const quietConsole = { lines: [] };
    for (const m of ['log', 'warn', 'groupCollapsed', 'groupEnd']) quietConsole[m] = (...args) => quietConsole.lines.push([m, ...args]);
    const dom = new JSDOM(`<!DOCTYPE html><body><div id="mw-content-text">${bodyHtml}</div>`
        + '<div id="verifier-report-view"><div id="verifier-report-uncited"></div></div></body>');
    const localStorage = { getItem: k => (k in storage ? storage[k] : null) };
    const deps = {
        uncitedSentences, runUncitedCheck, generateUncitedSystemPrompt, withUncitedCommentLanguage, uncitedChunkSize,
        uncitedModelFor, QUOTE_STATUSES, groupMaxTokens, callProviderAPI, localStorage,
    };
    const Harness = new Function('document', 'console', ...Object.keys(deps), `
        class Harness {
            constructor() {
                this.providers = ${JSON.stringify(PROVIDERS)};
                this.currentProvider = 'huggingface';
                this.lang = 'en';
                this.articleLangCode = 'en';
                this.reportUncited = null;
                this.reportCancelled = false;
                this.reportTokenUsage = { input: 0, output: 0 };
                this.progress = [];
            }
            t(en, params = {}) { return en.replace(/\\{(\\w+)\\}/g, (m, k) => (k in params ? String(params[k]) : m)); }
            updateReportProgress(done, total, phase) { this.progress.push([done, total, phase]); }
            renderReportSummary() {}
            reportArticleTitle() { return 'Morrison Bridge'; }
            llmRouterConfigOverrides(provider = this.currentProvider) { return provider === 'huggingface' ? { workerBase: 'https://router.example' } : {}; }
            isFindingSummaryClick() { return false; }
            scrollToUncitedSentence() {}
${methods}
        }
        return Harness;
    `)(dom.window.document, quietConsole, ...Object.values(deps));
    return { h: new Harness(), doc: dom.window.document, logged: quietConsole.lines };
}

const ref = n => `<sup class="reference"><a href="#cite_note-${n}">[${n}]</a></sup>`;
const ARTICLE = '<div class="mw-parser-output">'
    + `<p>The Morrison Bridge is a bridge.${ref(1)} Its lead is the lead check's.</p>`
    + '<div class="mw-heading mw-heading2"><h2 id="History">History</h2></div>'
    + `<p>It opened in 1998.${ref(2)} It was designed by Gustave Eiffel. It is painted red.</p>`
    + '</div>';

test('the setting is off by default, and the model follows the sidebar\'s provider', () => {
    assert.match(SRC, /this\.uncitedCheckEnabled = localStorage\.getItem\('verifier_uncited_check'\) === 'on';/,
        'off until turned on: the evidence is the model\'s memory, not a source');
    assert.doesNotMatch(SRC, /verifier_uncited_model/, 'no model setting: the rule decides');

    const { h } = harness();
    for (const free of ['liftwing', 'huggingface', 'publicai', 'liftwing-safeguard']) {
        h.currentProvider = free;
        assert.deepEqual(h.uncitedModel(), LIFTWING, `${free} is free, so Lift Wing`);
    }
    for (const paid of ['claude', 'gemini', 'openai']) {
        h.currentProvider = paid;
        assert.deepEqual(h.uncitedModel(), { provider: paid, model: PROVIDERS[paid].model, name: PROVIDERS[paid].name },
            `${paid} needs the editor's key, so its own model`);
    }
});

test('running the check alone is a quiet link under its setting, never a main-view button', () => {
    assert.match(SRC, /<a href="#" id="verifier-uncited-only-link">\$\{this\.t\('Run only this check on this article'\)\}<\/a><\/div>/,
        'in the setting\'s note');
    assert.match(SRC, /this\.verifyAllCitations\(\{ uncitedOnly: true \}\)/);
    assert.doesNotMatch(SRC, /new OO\.ui\.ButtonWidget\(\{\s*label: this\.t\('Run only this check/);
    // Alone, it runs whatever the setting says, with no citations and no lead check.
    assert.match(SRC, /const lead = this\.leadCheckEnabled && !uncitedOnly \? this\.articleLead\(\) : null;/);
    assert.match(SRC, /const uncited = uncitedOnly \|\| \(this\.uncitedCheckEnabled && !leadOnly\) \? this\.articleUncited\(\) : null;/);
    assert.match(SRC, /const citations = noCitations \? \[\] : this\.collectAllCitations\(\);/);
});

test('apiKeyFor reads a provider\'s stored key, and none for a keyless one', () => {
    const { h } = harness('', { storage: { claude_api_key: 'sk-x' } });
    assert.equal(h.apiKeyFor('claude'), 'sk-x');
    assert.equal(h.apiKeyFor('liftwing'), null);
    assert.equal(h.apiKeyFor('nonexistent'), null);
});

test('articleUncited reads the page\'s uncited body sentences once, and is empty (never null) when everything is cited', () => {
    const { h } = harness(ARTICLE);
    const uncited = h.articleUncited();
    assert.deepEqual(uncited.sentences.map(s => s.text), ['It was designed by Gustave Eiffel.', 'It is painted red.']);
    assert.equal(uncited.paragraphs[0].block.tagName, 'P', 'kept for highlighting the sentence');
    assert.equal(h.articleUncited(), uncited, 'cached');

    const cited = harness(`<div class="mw-parser-output"><p>Lead.</p><h2>History</h2><p>It opened in 1998.${ref(1)}</p></div>`).h;
    const none = cited.articleUncited();
    assert.deepEqual(none.sentences, [], 'the section still shows, saying there was nothing to check');
    assert.equal(none.readError, undefined);
    assert.equal(cited.uncitedStatusText({ ...none, state: 'done' }), 'no uncited sentences to check');

    const { h: unread, doc } = harness('');
    doc.getElementById('mw-content-text').remove();
    const err = unread.articleUncited();
    assert.equal(err.readError, true, 'no article text: said, not hidden');
    assert.equal(unread.uncitedStatusText({ ...err, state: 'done' }), 'could not read the article text');
});

const sentences = [
    { index: 0, paragraphIndex: 0, sectionTitle: 'History', text: 'It was designed by Gustave Eiffel.' },
    { index: 1, paragraphIndex: 0, sectionTitle: 'History', text: 'It is <b>painted</b> red.' },
    { index: 2, paragraphIndex: 1, sectionTitle: null, text: 'It cost 40 million.' },
];
const state = extra => ({ sentences, total: 3, model: LIFTWING, findings: [], unchecked: [], done: 0, state: 'pending', ...extra });

test('the section header says where the check is, in the lead check\'s words where they fit', () => {
    const { h } = harness();
    assert.equal(h.uncitedStatusText(state()), 'runs after the citations');
    assert.equal(h.uncitedStatusText(state({ state: 'stopped' })), 'not checked (stopped)');
    assert.equal(h.uncitedStatusText(state({ state: 'running', done: 2 })), 'checking, 2 of 3');
    assert.equal(h.uncitedStatusText(state({ state: 'done', done: 3 })), 'nothing found in 3 sentences');
    assert.equal(h.uncitedStatusText(state({ state: 'done', done: 3, findings: [{ index: 0 }, { index: 2 }] })), '2 of 3 sentences may be wrong');
    assert.equal(h.uncitedStatusText(state({ state: 'done', done: 3, unchecked: [{ index: 0 }, { index: 1 }, { index: 2 }] })),
        'nothing found in 0 of 3 sentences', 'every call failed: not "nothing found in 3"');
    assert.equal(h.uncitedStatusText(state({ state: 'done', done: 1 })), 'nothing found in 1 of 3 sentences', 'stopped part-way');
    assert.equal(h.uncitedStatusText({ sentences: [], total: 0, state: 'pending' }), 'no uncited sentences to check',
        'said from the start, not "runs after the citations"');
});

test('with no uncited sentences the phase makes no call and the section says so', async () => {
    const calls = [];
    const { h, doc } = harness('', { callProviderAPI: async () => { calls.push(1); return { text: '[]' }; } });
    h.reportUncited = { sentences: [], paragraphs: [], total: 0, capped: false, model: LIFTWING, findings: [], unchecked: [], done: 0, state: 'pending' };
    h.resetReportUncited();
    await h.runReportUncitedCheck(Date.now());
    assert.equal(calls.length, 0);
    assert.deepEqual(h.progress, []);
    const section = doc.querySelector('#verifier-report-uncited .sv-section');
    assert.ok(section, 'the section is shown');
    assert.equal(section.querySelector('.sv-section-status').textContent, 'no uncited sentences to check');
    assert.equal(section.querySelector('.sv-section-note'), null, 'no "Checked with…" note: nothing was checked');
});

function render(h, doc, uncited) {
    const el = doc.createElement('div');
    el.innerHTML = h.uncitedCheckHtml(uncited);
    return el;
}

test('a finding is a report row: its verdict, the sentence, the comment, and the doubted words only if verbatim', () => {
    const { h, doc } = harness();
    const done = render(h, doc, state({
        state: 'done', done: 3,
        findings: [
            { index: 0, text: sentences[0].text, sectionTitle: 'History', excerpt: 'Gustave Eiffel', excerptStatus: 'exact', comments: 'Anna Holt designed it.', confidence: 'high' },
            { index: 1, text: sentences[1].text, sectionTitle: 'History', excerpt: 'PAINTED RED', excerptStatus: 'normalized', comments: 'It is grey.', confidence: 'high' },
            { index: 2, text: sentences[2].text, sectionTitle: null, excerpt: 'cost 400 million', excerptStatus: 'not-found', comments: '', confidence: 'medium' },
        ],
    }));
    assert.match(done.querySelector('.sv-section-note').textContent, /^Checked with Lift Wing, against its general knowledge rather than a source\./);
    const rows = [...done.querySelectorAll('.sv-rows > .sv-finding')];
    assert.deepEqual(rows.map(r => r.dataset.uncitedIndex), ['0', '1', '2']);
    assert.ok(rows.every(r => r.classList.contains('sv-uncited-finding') && r.classList.contains('verdict-partial')));
    assert.equal(rows[0].querySelector('.sv-verdict').textContent, 'No citation, may be wrong');
    assert.equal(rows[0].querySelector('.sv-finding-claim').textContent, 'It was designed by Gustave Eiffel.');
    assert.equal(rows[0].querySelector('.sv-finding-comment').textContent, 'Anna Holt designed it.');
    assert.deepEqual([...rows[0].querySelectorAll('.sv-finding-details .sv-finding-note')].map(n => n.textContent),
        ['Doubted: “Gustave Eiffel”', 'Section: History']);
    assert.ok(rows[0].querySelector('.sv-finding-details').hidden, 'details closed until the row is opened');
    assert.equal(rows[1].querySelector('.sv-finding-claim').textContent, 'It is <b>painted</b> red.', 'escaped, not markup');
    assert.doesNotMatch(rows[1].textContent, /Doubted/, 'found only after normalization: the model\'s words, not the article\'s');
    assert.doesNotMatch(rows[2].textContent, /400 million|Doubted|Section:/, 'words not in the article are never shown');
    assert.equal(rows[2].querySelector('.sv-finding-comment'), null);
});

test('notes: none before it runs; the model once it does; the cap, a stop part-way, and unchecked sentences', () => {
    const { h, doc } = harness();
    assert.equal(render(h, doc, state()).querySelectorAll('.sv-section-note').length, 0);
    const notes = [...render(h, doc, state({
        total: 160, capped: true, state: 'done', done: 2,
        unchecked: [{ index: 1, text: 'x', error: 'error' }],
    })).querySelectorAll('.sv-section-note')].map(n => n.textContent);
    assert.equal(notes.length, 4);
    assert.match(notes[0], /^Checked with Lift Wing/);
    assert.deepEqual(notes.slice(1), [
        'Only the first 3 of 160 sentences with no citation were checked.',
        'Stopped after 2 of 3 sentences.',
        '1 sentence with no citation could not be checked.',
    ]);
});

test('the section is a closed .sv-section like the lead check\'s, and only exists when the check runs', () => {
    const { h, doc } = harness();
    h.resetReportUncited();
    assert.equal(doc.getElementById('verifier-report-uncited').innerHTML, '', 'nothing without a run');

    h.reportUncited = state();
    h.resetReportUncited();
    const section = doc.querySelector('#verifier-report-uncited > details.sv-section');
    assert.equal(section.open, false, 'its results arriving must not push the citations about');
    assert.equal(section.querySelector('.sv-section-title').textContent, 'Uncited text');
    assert.equal(section.querySelector('.sv-section-status').textContent, 'runs after the citations');

    h.reportUncited.state = 'running';
    h.reportUncited.done = 1;
    h.renderReportUncited();
    assert.equal(section.querySelector('.sv-section-status').textContent, 'checking, 1 of 3');
});

test('with a free provider the phase runs on Lift Wing, and renders its findings and tokens', async () => {
    const calls = [];
    const callProviderAPI = async (provider, config) => {
        calls.push({ provider, config });
        return {
            text: JSON.stringify({ issues: [{ id: 1, excerpt: 'Gustave Eiffel', comments: 'Anna Holt designed it.', confidence: 'high' }] }),
            usage: { input: 120, output: 15 },
        };
    };
    const { h, doc } = harness(ARTICLE, { callProviderAPI });
    h.currentProvider = 'huggingface';
    h.reportUncited = { ...h.articleUncited(), model: h.uncitedModel(), findings: [], unchecked: [], done: 0, state: 'pending' };
    h.resetReportUncited();
    await h.runReportUncitedCheck(Date.now());

    assert.equal(calls.length, 1);
    assert.equal(calls[0].provider, 'liftwing');
    assert.equal(calls[0].config.model, PROVIDERS.liftwing.model);
    assert.equal(calls[0].config.apiKey, null, 'keyless');
    assert.equal(calls[0].config.workerBase, undefined);
    assert.match(calls[0].config.userContent, /^Article: Morrison Bridge$/m);
    assert.match(calls[0].config.userContent, /1\. "It was designed by Gustave Eiffel\."/);
    assert.equal(calls[0].config.systemPrompt, generateUncitedSystemPrompt());

    assert.equal(h.reportUncited.state, 'done');
    assert.deepEqual(h.reportUncited.findings.map(f => [f.index, f.excerptStatus]), [[0, 'exact']]);
    assert.equal(h.reportUncited.done, 2);
    assert.deepEqual(h.reportTokenUsage, { input: 120, output: 15 });
    assert.deepEqual(h.progress.at(-1), [2, 2, 'Checking uncited text']);
    assert.equal(doc.querySelector('#verifier-report-uncited .sv-section-status').textContent, '1 of 2 sentences may be wrong');
    assert.equal(doc.querySelectorAll('#verifier-report-uncited .sv-uncited-finding').length, 1);
});

test('with a paid provider the phase uses that provider\'s model and the editor\'s key', async () => {
    const calls = [];
    const callProviderAPI = async (provider, config) => {
        calls.push({ provider, config });
        return { text: '{"issues": []}', usage: { input: 1, output: 1 } };
    };
    const { h } = harness(ARTICLE, { callProviderAPI, storage: { claude_api_key: 'sk-x' } });
    h.currentProvider = 'claude';
    h.lang = 'ru';
    h.articleLangCode = 'ru';
    h.reportUncited = { ...h.articleUncited(), model: h.uncitedModel(), findings: [], unchecked: [], done: 0, state: 'pending' };
    await h.runReportUncitedCheck(Date.now());
    assert.equal(calls[0].provider, 'claude');
    assert.equal(calls[0].config.model, PROVIDERS.claude.model);
    assert.equal(calls[0].config.apiKey, 'sk-x');
    assert.equal(calls[0].config.workerBase, undefined);
    assert.match(calls[0].config.systemPrompt, /Write the "comments" field in Russian/);
    assert.deepEqual(h.reportUncited.findings, []);
});

test('a Stop before the phase\'s first call checks nothing and says so', async () => {
    const { h } = harness(ARTICLE, { callProviderAPI: async () => { throw new Error('must not be called'); } });
    h.reportUncited = { ...h.articleUncited(), model: h.uncitedModel(), findings: [], unchecked: [], done: 0, state: 'pending' };
    h.reportCancelled = true;
    await h.runReportUncitedCheck(Date.now());
    assert.equal(h.reportUncited.state, 'done');
    assert.equal(h.reportUncited.done, 0);
});

test('after a run the section says what was read and done, lists the sentences sent, and logs each call to the console', async () => {
    let n = 0;
    const callProviderAPI = async () => {
        n++;
        if (n === 1) return { text: JSON.stringify({ issues: [{ id: 1, excerpt: 'Gustave Eiffel', comments: 'Anna Holt designed it.', confidence: 'high' }] }), usage: {} };
        throw Object.assign(new Error('HTTP 400: bad request'), { status: 400 });
    };
    const { h, doc, logged } = harness(ARTICLE, { callProviderAPI });
    const uncited = h.articleUncited();
    assert.deepEqual(uncited.stats, { paragraphs: 1, sentences: 3, cited: 1, short: 0, leadIns: 0, uncited: 2 });
    h.reportUncited = { ...uncited, model: h.uncitedModel(), findings: [], unchecked: [], done: 0, state: 'pending' };
    assert.equal(h.uncitedCountsText(h.reportUncited), 'Paragraphs read: 1; sentences: 3 (1 with a citation, 2 without).',
        'what was read is known before the run');
    h.resetReportUncited();
    await h.runReportUncitedCheck(Date.now());

    const counts = doc.querySelector('#verifier-report-uncited .sv-uncited-counts').textContent;
    assert.equal(counts, 'Paragraphs read: 1; sentences: 3 (1 with a citation, 2 without). '
        + 'Model calls: 1 (0 failed); sentences flagged: 1, shown: 1.');
    const list = doc.querySelector('#verifier-report-uncited details.sv-uncited-read');
    assert.equal(list.open, false, 'folded');
    assert.equal(list.querySelector('.sv-sublist-title').textContent, 'Sentences checked (2)');
    assert.deepEqual([...list.querySelectorAll('li')].map(li => li.textContent),
        ['It was designed by Gustave Eiffel. (History)', 'It is painted red. (History)']);

    // Opened, the list stays open as the section re-renders.
    list.open = true;
    h.renderReportUncited();
    assert.equal(doc.querySelector('#verifier-report-uncited details.sv-uncited-read').open, true);

    const group = logged.find(l => l[0] === 'groupCollapsed');
    assert.match(group[1], /^\[Verifier\] Uncited-text check: 2 sentences, 1 calls, 1 shown \(Lift Wing/);
    const answer = logged.find(l => l[0] === 'log' && l[1] === 'answer');
    assert.match(answer[2], /Anna Holt designed it/, 'the raw answer, for when nothing is found');
    assert.equal(logged.filter(l => l[0] === 'groupCollapsed').length, logged.filter(l => l[0] === 'groupEnd').length);
});

test('a failed call is counted in the section and logged with its error', async () => {
    const callProviderAPI = async () => { throw Object.assign(new Error('HTTP 400: bad request'), { status: 400 }); };
    const { h, doc, logged } = harness(ARTICLE, { callProviderAPI });
    h.reportUncited = { ...h.articleUncited(), model: h.uncitedModel(), findings: [], unchecked: [], done: 0, state: 'pending' };
    h.resetReportUncited();
    await h.runReportUncitedCheck(Date.now());
    assert.match(doc.querySelector('#verifier-report-uncited .sv-uncited-counts').textContent, /Model calls: 1 \(1 failed\); sentences flagged: 0, shown: 0\.$/);
    assert.equal(doc.querySelector('#verifier-report-uncited .sv-section-status').textContent, 'nothing found in 0 of 2 sentences');
    assert.ok(logged.some(l => l[0] === 'log' && l[1] === 'answer' && /\(failed\) HTTP 400/.test(l[2])));
});

test('run alone, the section opens: it is all the report holds', () => {
    const { h, doc } = harness();
    h.reportUncitedOnly = true;
    h.reportUncited = state();
    h.resetReportUncited();
    assert.equal(doc.querySelector('#verifier-report-uncited > details.sv-section').open, true);
});
