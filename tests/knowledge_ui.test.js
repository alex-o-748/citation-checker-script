import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { uncitedSentences } from '../core/uncited.js';
import { generateUncitedSystemPrompt, withUncitedCommentLanguage, uncitedChunkSize, uncitedModelFor } from '../core/uncited-check.js';
import { runKnowledgeCheck, isKnowledgeDoubted } from '../core/knowledge-check.js';
import { needsSeverity, compareSeverity } from '../core/severity.js';
import { attachArticleContext } from '../core/article-context.js';
import { groupMaxTokens } from '../core/providers.js';
import { PROVIDERS } from '../core/models.js';

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');
const SRC = fs.readFileSync(MAIN_JS, 'utf8');

// Same approach as uncited_ui.test.js: the shipped methods are lifted out of
// main.js and run against jsdom.
function extractMethod(signature) {
    const start = SRC.indexOf(`        ${signature}`);
    assert.ok(start !== -1, `method not found in main.js: ${signature}`);
    const end = SRC.indexOf('\n        }\n', start);
    assert.ok(end !== -1, `end of method not found: ${signature}`);
    return SRC.slice(start, end + '\n        }\n'.length);
}

const ref = n => `<sup class="reference"><a href="#cite_note-${n}">[${n}]</a></sup>`;
const ARTICLE = '<div class="mw-parser-output">'
    + '<p>The Morrison Bridge is a bridge in Portland.</p>'
    + '<div class="mw-heading mw-heading2"><h2 id="History">History</h2></div>'
    + `<p>It opened in 1998.${ref(1)} It was designed by Gustave Eiffel.${ref(2)} It is painted red.${ref(3)}</p>`
    + '</div>';

// A report card as the report builds one: a block holding a finding row.
const cardHtml = n => `<div class="verifier-report-card" data-doc-order="${n - 1}"><div class="sv-finding">`
    + '<div class="sv-finding-head"><span class="sv-finding-verdict"><span class="sv-verdict">Not supported</span></span></div>'
    + '<div class="sv-finding-details"><div class="sv-finding-actions"></div></div></div></div>';

function harness({ answer, provider = 'huggingface' } = {}) {
    const methods = [
        'articleUncited() {',
        'uncitedModel() {',
        'apiKeyFor(providerId) {',
        'async runReportKnowledgeCheck(startTime) {',
        'renderReportKnowledge(unit) {',
        'applyReportSort() {',
        'blockSeverity(block) {',
    ].map(extractMethod).join('\n');
    const dom = new JSDOM(`<!DOCTYPE html><body><div id="mw-content-text">${ARTICLE}</div>`
        + `<div id="verifier-report-results">${[1, 2, 3].map(cardHtml).join('')}</div></body>`);
    const doc = dom.window.document;
    const calls = [];
    const callProviderAPI = async (p, args) => {
        calls.push({ provider: p, ...args });
        return answer(args);
    };
    const quietConsole = { lines: [] };
    for (const m of ['log', 'warn', 'groupCollapsed', 'groupEnd']) quietConsole[m] = (...a) => quietConsole.lines.push([m, ...a]);
    const deps = {
        uncitedSentences, generateUncitedSystemPrompt, withUncitedCommentLanguage, uncitedChunkSize, uncitedModelFor,
        runKnowledgeCheck, isKnowledgeDoubted, needsSeverity, compareSeverity, attachArticleContext, groupMaxTokens,
        callProviderAPI, localStorage: { getItem: () => null },
    };
    const Harness = new Function('document', 'console', ...Object.keys(deps), `
        class Harness {
            constructor() {
                this.providers = ${JSON.stringify(PROVIDERS)};
                this.currentProvider = ${JSON.stringify(provider)};
                this.lang = 'en';
                this.articleLangCode = 'en';
                this.reportCancelled = false;
                this.reportTokenUsage = { input: 0, output: 0 };
                this.reportSeverity = false;
                this.reportKnowledge = true;
                this.reportSort = 'severity';
                this.reportCardEls = new Map();
                this.units = [];
                this.progress = [];
            }
            t(en, params = {}) { return en.replace(/\\{(\\w+)\\}/g, (m, k) => (k in params ? String(params[k]) : m)); }
            updateReportProgress(done, total, phase) { this.progress.push([done, total, phase]); }
            renderReportSummary() {}
            getCountedReportUnits() { return this.units; }
            reportArticleTitle() { return 'Morrison Bridge'; }
            llmRouterConfigOverrides() { return {}; }
${methods}
        }
        return Harness;
    `)(doc, quietConsole, ...Object.values(deps));
    const h = new Harness();
    const markers = [...doc.querySelectorAll('.reference a')];
    const cards = [...doc.querySelectorAll('.verifier-report-card .sv-finding')];
    const claims = ['It opened in 1998.', 'It was designed by Gustave Eiffel.', 'It is painted red.'];
    const verdicts = ['NOT SUPPORTED', 'NOT SUPPORTED', 'SUPPORTED'];
    h.units = claims.map((claimText, i) => ({
        citationNumber: i + 1, claimText, verdict: verdicts[i], comments: 'The source says Smith.', refElement: markers[i],
    }));
    h.units.forEach((u, i) => h.reportCardEls.set(u, cards[i]));
    return { h, doc, calls };
}

const doubtSecond = () => ({
    text: JSON.stringify({ issues: [{ id: 2, excerpt: 'Gustave Eiffel', comments: 'Eiffel did not design it.', confidence: 'high' }] }),
    usage: { input: 50, output: 10 },
});

test('the setting is off by default and persisted', () => {
    assert.match(SRC, /this\.knowledgeCheckEnabled = localStorage\.getItem\('verifier_knowledge_check'\) === 'on';/);
    assert.match(SRC, /localStorage\.setItem\('verifier_knowledge_check', this\.knowledgeCheckEnabled \? 'on' : 'off'\)/);
    assert.match(SRC, /this\.reportKnowledge = this\.knowledgeCheckEnabled && !noCitations;/);
});

test('it runs after the verdicts and before the severity pass', () => {
    const knowledge = SRC.indexOf('await this.runReportKnowledgeCheck(startTime);');
    const severity = SRC.indexOf('await this.rankReportBySeverity(delayBetweenCalls);');
    const uncited = SRC.indexOf('await this.runReportUncitedCheck(startTime);');
    assert.ok(uncited !== -1 && knowledge > uncited && severity > knowledge);
});

test('only flagged claims are sent, with their context, never the source, verdict or comment', async () => {
    const { h, calls } = harness({ answer: doubtSecond });
    await h.runReportKnowledgeCheck(Date.now());
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.provider, 'liftwing', 'a free provider runs it on the uncited check\'s model');
    assert.match(call.userContent, /1\. "It opened in 1998\."\n2\. "It was designed by Gustave Eiffel\."/);
    assert.doesNotMatch(call.userContent, /\d\. "It is painted red\."/, 'a supported claim is not checked');
    assert.match(call.userContent, /Opening paragraph, for context:\nThe Morrison Bridge is a bridge in Portland\./);
    assert.match(call.userContent, /Section: History/);
    assert.doesNotMatch(call.userContent, /Smith|NOT SUPPORTED/);
    assert.equal(h.reportTokenUsage.input, 50);
});

test('a doubted claim gets "Likely wrong" and the model\'s comment in its details; the other is untouched', async () => {
    const { h } = harness({ answer: doubtSecond });
    await h.runReportKnowledgeCheck(Date.now());
    const [first, second] = h.units.map(u => h.reportCardEls.get(u));
    assert.equal(second.querySelector('.sv-knowledge-tag').textContent, 'Likely wrong');
    assert.match(second.querySelector('.sv-knowledge-note').textContent, /Without reading the source, the model believes: Eiffel did not design it\./);
    assert.equal(first.querySelector('.sv-knowledge-tag'), null, 'not doubted is never labelled');
    assert.equal(first.querySelector('.sv-knowledge-note'), null);
    assert.equal(h.units[0].knowledge.outcome, 'not_doubted');
    assert.equal(h.units[1].knowledge.outcome, 'doubted');
});

test('"Most serious first" puts a doubted block first; article order otherwise', async () => {
    const { h, doc } = harness({ answer: doubtSecond });
    await h.runReportKnowledgeCheck(Date.now());
    const order = () => [...doc.querySelectorAll('#verifier-report-results > .verifier-report-card')].map(el => el.dataset.docOrder);
    assert.deepEqual(order(), ['1', '0', '2']);
    h.reportSort = 'document';
    h.applyReportSort();
    assert.deepEqual(order(), ['0', '1', '2']);
});

test('a failed call changes nothing on the cards', async () => {
    const { h, doc } = harness({ answer: () => { throw new Error('Request failed (400): bad'); } });
    await h.runReportKnowledgeCheck(Date.now());
    assert.equal(doc.querySelectorAll('.sv-knowledge-tag').length, 0);
    assert.equal(h.units[0].knowledge.outcome, 'error');
});

test('the knowledge check is kept out of the log and the exports', () => {
    const run = extractMethod('async runReportKnowledgeCheck(startTime) {');
    assert.doesNotMatch(run, /logVerification|generateWikitextReport/);
    assert.doesNotMatch(extractMethod('generateWikitextReport() {'), /knowledge/i);
});
