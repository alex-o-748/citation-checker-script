import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { uncitedSentences } from '../core/uncited.js';
import {
    runUncitedCheck, generateUncitedSystemPrompt, withUncitedCommentLanguage, uncitedChunkSize,
    UNCITED_DEFAULT_PROVIDER,
} from '../core/uncited-check.js';
import { QUOTE_STATUSES } from '../core/quote.js';
import { groupMaxTokens } from '../core/providers.js';
import { PROVIDERS } from '../core/models.js';

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
        'uncitedProvider() {',
        'apiKeyFor(providerId) {',
        'renderReportUncited() {',
        'uncitedCheckHtml(uncited) {',
        'uncitedFindingCardHtml(f) {',
        'uncitedSentenceHtml(f) {',
        'runReportUncitedCheck(startTime) {',
        'escapeHtml(str) {',
    ].map(sig => extractMethod(sig.startsWith('runReport') ? `async ${sig}` : sig)).join('\n');

    const dom = new JSDOM(`<!DOCTYPE html><body><div id="mw-content-text">${bodyHtml}</div><div id="verifier-report-uncited"></div></body>`);
    const localStorage = { getItem: k => (k in storage ? storage[k] : null) };
    const deps = {
        uncitedSentences, runUncitedCheck, generateUncitedSystemPrompt, withUncitedCommentLanguage, uncitedChunkSize,
        UNCITED_DEFAULT_PROVIDER, QUOTE_STATUSES, groupMaxTokens, callProviderAPI, localStorage,
    };
    const Harness = new Function('document', 'console', ...Object.keys(deps), `
        class Harness {
            constructor() {
                this.providers = ${JSON.stringify(PROVIDERS)};
                this.currentProvider = 'huggingface';
                this.uncitedModelChoice = 'default';
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
            llmRouterConfigOverrides() { return { workerBase: 'https://router.example' }; }
            scrollToUncitedSentence() {}
${methods}
        }
        return Harness;
    `)(dom.window.document, console, ...Object.values(deps));
    return { h: new Harness(), doc: dom.window.document };
}

const ref = n => `<sup class="reference"><a href="#cite_note-${n}">[${n}]</a></sup>`;
const ARTICLE = '<div class="mw-parser-output">'
    + `<p>The Morrison Bridge is a bridge.${ref(1)} Its lead is the lead check's.</p>`
    + '<div class="mw-heading mw-heading2"><h2 id="History">History</h2></div>'
    + `<p>It opened in 1998.${ref(2)} It was designed by Gustave Eiffel. It is painted red.</p>`
    + '</div>';

test('the setting is off by default, and the check runs on its own model unless told otherwise', () => {
    assert.match(SRC, /this\.uncitedCheckEnabled = localStorage\.getItem\('verifier_uncited_check'\) === 'on';/,
        'off until turned on: the evidence is the model\'s memory, not a source');
    assert.match(SRC, /this\.uncitedModelChoice = localStorage\.getItem\('verifier_uncited_model'\) === 'current' \? 'current' : 'default';/);
    assert.equal(UNCITED_DEFAULT_PROVIDER, 'liftwing');
    assert.equal(PROVIDERS[UNCITED_DEFAULT_PROVIDER].requiresKey, false, 'the default needs no key');
    assert.notEqual(UNCITED_DEFAULT_PROVIDER, 'huggingface', 'not the keyless default provider, which did worst on it');

    const { h } = harness();
    assert.equal(h.uncitedProvider(), 'liftwing');
    h.uncitedModelChoice = 'current';
    assert.equal(h.uncitedProvider(), 'huggingface', 'the citation checks\' provider');
});

test('apiKeyFor reads a provider\'s stored key, and none for a keyless one', () => {
    const { h } = harness('', { storage: { claude_api_key: 'sk-x' } });
    assert.equal(h.apiKeyFor('claude'), 'sk-x');
    assert.equal(h.apiKeyFor('liftwing'), null);
    assert.equal(h.apiKeyFor('nonexistent'), null);
});

test('articleUncited reads the page\'s uncited body sentences once, and is null when everything is cited', () => {
    const { h } = harness(ARTICLE);
    const uncited = h.articleUncited();
    assert.deepEqual(uncited.sentences.map(s => s.text), ['It was designed by Gustave Eiffel.', 'It is painted red.']);
    assert.equal(uncited.paragraphs[0].block.tagName, 'P', 'kept for scrolling to the sentence');
    assert.equal(h.articleUncited(), uncited, 'cached');

    const cited = harness(`<div class="mw-parser-output"><p>Lead.</p><h2>History</h2><p>It opened in 1998.${ref(1)}</p></div>`).h;
    assert.equal(cited.articleUncited(), null);
});

const sentences = [
    { index: 0, paragraphIndex: 0, sectionTitle: 'History', text: 'It was designed by Gustave Eiffel.' },
    { index: 1, paragraphIndex: 0, sectionTitle: 'History', text: 'It is <b>painted</b> red.' },
    { index: 2, paragraphIndex: 1, sectionTitle: null, text: 'It cost 40 million.' },
];

function render(h, doc, uncited) {
    const el = doc.createElement('div');
    el.innerHTML = h.uncitedCheckHtml(uncited);
    return el;
}

test('the section shows its state, and names the model once it has run', () => {
    const { h, doc } = harness();
    const pending = render(h, doc, { sentences, total: 3, provider: 'liftwing', state: 'pending' });
    assert.match(pending.textContent, /checked after the citations/);
    assert.equal(pending.querySelector('.sv-uncited-model'), null, 'nothing has run yet');

    const running = render(h, doc, { sentences, total: 3, provider: 'liftwing', state: 'running', done: 2 });
    assert.match(running.textContent, /\(2 of 3 sentences\)/);
    assert.match(running.querySelector('.sv-uncited-model').textContent, new RegExp(`Checked with ${PROVIDERS.liftwing.name}\\.`));

    const clean = render(h, doc, { sentences, total: 3, provider: 'liftwing', state: 'done', done: 3, findings: [], unchecked: [] });
    assert.match(clean.textContent, /Nothing in the 3 sentences with no citation looks wrong to the model\./);
    assert.equal(clean.querySelector('.sv-uncited-intro'), null, 'no warning text without a finding');
});

test('a finding is a card with the doubted words marked only where they appear verbatim', () => {
    const { h, doc } = harness();
    const done = render(h, doc, {
        sentences, total: 3, provider: 'liftwing', state: 'done', done: 3, unchecked: [],
        findings: [
            { index: 0, text: sentences[0].text, sectionTitle: 'History', excerpt: 'Gustave Eiffel', excerptStatus: 'exact', comments: 'Anna Holt designed it.', confidence: 'high' },
            { index: 1, text: sentences[1].text, sectionTitle: 'History', excerpt: 'PAINTED RED', excerptStatus: 'normalized', comments: 'It is grey.', confidence: 'high' },
            { index: 2, text: sentences[2].text, sectionTitle: null, excerpt: 'cost 400 million', excerptStatus: 'not-found', comments: '', confidence: 'medium' },
        ],
    });
    assert.match(done.textContent, /3 of 3 sentences with no citation may be wrong\./);
    assert.match(done.querySelector('.sv-uncited-intro').textContent, /not a source: find a reliable source before changing anything/);
    const cards = [...done.querySelectorAll('.sv-uncited-card')];
    assert.deepEqual(cards.map(c => c.dataset.uncitedIndex), ['0', '1', '2']);
    assert.equal(cards[0].querySelector('.sv-uncited-tag').textContent, 'No citation, may be wrong');
    assert.equal(cards[0].querySelector('.sv-uncited-excerpt').textContent, 'Gustave Eiffel');
    assert.equal(cards[0].querySelector('.sv-uncited-sentence').textContent, 'It was designed by Gustave Eiffel.');
    assert.match(cards[0].textContent, /Section: History/);
    assert.equal(cards[1].querySelector('.sv-uncited-excerpt'), null, 'found only after normalization: nothing marked');
    assert.equal(cards[1].querySelector('.sv-uncited-sentence').textContent, 'It is <b>painted</b> red.', 'escaped, not markup');
    assert.equal(cards[2].querySelector('.sv-uncited-excerpt'), null);
    assert.doesNotMatch(cards[2].textContent, /400 million/, 'words not in the article are never shown');
    assert.doesNotMatch(cards[2].textContent, /Section:/);
    assert.equal(cards[2].querySelector('.report-card-comment'), null);
});

test('notes: the sentence cap, a stop part-way, and unchecked sentences', () => {
    const { h, doc } = harness();
    const el = render(h, doc, {
        sentences, total: 160, capped: true, provider: 'liftwing', state: 'done', done: 2, findings: [],
        unchecked: [{ index: 1, text: 'x', error: 'error' }],
    });
    const notes = [...el.querySelectorAll('.sv-uncited-note')].map(n => n.textContent);
    assert.deepEqual(notes, [
        'Only the first 3 of 160 sentences with no citation were checked.',
        'Stopped after 2 of 3 sentences.',
        '1 sentence with no citation could not be checked.',
    ]);
});

test('the phase runs on the uncited provider, with its model and key, and reports its findings and tokens', async () => {
    const calls = [];
    const callProviderAPI = async (provider, config) => {
        calls.push({ provider, config });
        return {
            text: JSON.stringify({ issues: [{ id: 1, excerpt: 'Gustave Eiffel', comments: 'Anna Holt designed it.', confidence: 'high' }] }),
            usage: { input: 120, output: 15 },
        };
    };
    const { h, doc } = harness(ARTICLE, { callProviderAPI });
    const uncited = h.articleUncited();
    h.reportUncited = { ...uncited, provider: h.uncitedProvider(), findings: [], unchecked: [], state: 'pending' };
    await h.runReportUncitedCheck(Date.now());

    assert.equal(calls.length, 1);
    assert.equal(calls[0].provider, 'liftwing', 'not the citation checks\' huggingface');
    assert.equal(calls[0].config.model, PROVIDERS.liftwing.model);
    assert.equal(calls[0].config.apiKey, null);
    assert.equal(calls[0].config.workerBase, undefined, 'the router override belongs to the current provider only');
    assert.match(calls[0].config.userContent, /^Article: Morrison Bridge$/m);
    assert.match(calls[0].config.userContent, /1\. "It was designed by Gustave Eiffel\."/);
    assert.equal(calls[0].config.systemPrompt, generateUncitedSystemPrompt());

    assert.equal(h.reportUncited.state, 'done');
    assert.deepEqual(h.reportUncited.findings.map(f => [f.index, f.excerptStatus]), [[0, 'exact']]);
    assert.equal(h.reportUncited.done, 2);
    assert.deepEqual(h.reportTokenUsage, { input: 120, output: 15 });
    assert.deepEqual(h.progress.at(-1), [2, 2, 'Checking uncited text']);
    assert.equal(doc.querySelectorAll('#verifier-report-uncited .sv-uncited-card').length, 1, 'rendered into the report');
});

test('with "same as citation checks" the phase uses the current provider, its key and its router override', async () => {
    const calls = [];
    const callProviderAPI = async (provider, config) => {
        calls.push({ provider, config });
        return { text: '{"issues": []}', usage: { input: 1, output: 1 } };
    };
    const { h } = harness(ARTICLE, { callProviderAPI, storage: { hf_api_key: 'hf-x' } });
    h.uncitedModelChoice = 'current';
    h.lang = 'ru';
    h.articleLangCode = 'ru';
    h.reportUncited = { ...h.articleUncited(), provider: h.uncitedProvider(), findings: [], unchecked: [], state: 'pending' };
    await h.runReportUncitedCheck(Date.now());
    assert.equal(calls[0].provider, 'huggingface');
    assert.equal(calls[0].config.apiKey, 'hf-x');
    assert.equal(calls[0].config.workerBase, 'https://router.example');
    assert.match(calls[0].config.systemPrompt, /Write the "comments" field in Russian/);
    assert.deepEqual(h.reportUncited.findings, []);
});

test('a Stop before the phase\'s first call checks nothing and says so', async () => {
    const { h } = harness(ARTICLE, { callProviderAPI: async () => { throw new Error('must not be called'); } });
    h.reportUncited = { ...h.articleUncited(), provider: 'liftwing', findings: [], unchecked: [], state: 'pending' };
    h.reportCancelled = true;
    await h.runReportUncitedCheck(Date.now());
    assert.equal(h.reportUncited.state, 'done');
    assert.equal(h.reportUncited.done, 0);
});
