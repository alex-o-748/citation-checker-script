import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    groupSourceEntries, shouldSkipCollective, hasUnreadSource, isJudgedUnavailable,
} from '../core/groups.js';
import { assembleGroupSources } from '../core/prompts.js';

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');

// main.js is a userscript in an IIFE, so lift verifyGroupCollective() out of
// it and run it against stubs for everything around it (as
// report_filters.test.js does for applyReportFilters()).
function harness({ sources, ownVerdicts, groupVerdict = 'PARTIALLY SUPPORTED' }) {
    const src = fs.readFileSync(MAIN_JS, 'utf8');
    const start = src.indexOf('        async verifyGroupCollective(');
    const end = src.indexOf('        // Merges per-source results and collective group verdicts into one', start);
    assert.ok(start !== -1 && end > start, 'verifyGroupCollective() not found in main.js');
    const method = src.slice(start, end);

    const Harness = new Function(
        'groupSourceEntries', 'shouldSkipCollective', 'hasUnreadSource', 'isJudgedUnavailable', 'assembleGroupSources', 'withRetry',
        `return class Harness {\n${method}\n}`
    )(groupSourceEntries, shouldSkipCollective, hasUnreadSource, isJudgedUnavailable, assembleGroupSources, fn => fn());

    const citations = sources.map(([url], i) => ({
        citationNumber: String(44 + i), url, claimText: 'Thrift stores keep still-useful products from landfills.',
        groupId: 'g', groupSize: sources.length, groupIndex: i,
    }));
    const h = new Harness();
    Object.assign(h, {
        groupCalls: 0,
        hidden: [],
        sourceCache: new Map(sources.map(([url, content]) => [url, { content, error: null, status: 200 }])),
        reportResults: citations.map((c, i) => ({ citationNumber: c.citationNumber, groupId: 'g', verdict: ownVerdicts[i] })),
        reportGroupResults: new Map(),
        severityInputs: new Map(),
        reportSeverity: false,
        reportCancelled: true, // skips the closing rate-limit pause
        reportTokenUsage: { input: 0, output: 0 },
        providers: {},
        currentProvider: 'liftwing',
        t: s => s,
        hideGroupCollectiveSlot(id) { this.hidden.push(id); },
        renderReportSummary() {},
        applyReportFilters() {},
        updateReportProgress() {},
        renderGroupCollectiveResult() {},
        demotesInReport: () => false,
        logVerification: () => 'id',
        buildQuoteView: () => ({ quote: null, display: null, verified: false, status: 'empty' }),
        parseVerificationResult: () => ({ verdict: groupVerdict, support_score: 50, comments: 'c' }),
        async callProviderAPIGroup(_claim, text) {
            this.groupCalls++;
            this.groupText = text;
            return { text: '{}', usage: { input: 1, output: 1 } };
        },
    });
    return { h, citations };
}

const page = body => `Source URL: x\n\nSource Content:\n${body}`;

// Garbage [44][45], 2026-11-17.
test('every member judged unavailable on its own: no combined verdict, the members stand', async () => {
    const { h, citations } = harness({
        sources: [['https://proquest.example', page('Login required.')], ['https://springer.example', page('Abstract: thrift stores, flea markets…')]],
        ownVerdicts: ['SOURCE UNAVAILABLE', 'SOURCE UNAVAILABLE'],
    });
    await h.verifyGroupCollective(citations[1], citations, 0, 0, 0, 0);
    assert.equal(h.groupCalls, 0);
    assert.deepEqual(h.reportGroupResults.get('g'), { skipped: true, groupId: 'g' });
    assert.deepEqual(h.hidden, ['g']);
});

test('one judged unavailable of three: the combined check runs without that page', async () => {
    const { h, citations } = harness({
        sources: [['https://a.example', page('PAGE A')], ['https://b.example', page('PAGE B')], ['https://c.example', page('PAGE C')]],
        ownVerdicts: ['SUPPORTED', 'SOURCE UNAVAILABLE', 'PARTIALLY SUPPORTED'],
    });
    await h.verifyGroupCollective(citations[2], citations, 0, 0, 0, 0);
    assert.equal(h.groupCalls, 1);
    assert.match(h.groupText, /PAGE A/);
    assert.doesNotMatch(h.groupText, /PAGE B/);
    assert.match(h.groupText, /PAGE C/);
    assert.equal(h.reportGroupResults.get('g').verdict, 'PARTIALLY SUPPORTED');
});

test('a member whose own check errored still lends its page to the combined check', async () => {
    const { h, citations } = harness({
        sources: [['https://a.example', page('PAGE A')], ['https://b.example', page('PAGE B')]],
        ownVerdicts: ['SUPPORTED', 'ERROR'],
    });
    await h.verifyGroupCollective(citations[1], citations, 0, 0, 0, 0);
    assert.equal(h.groupCalls, 1);
    assert.match(h.groupText, /PAGE B/);
});

test('the severity pass is told a judged-unavailable sibling went unread', async () => {
    const { h, citations } = harness({
        sources: [['https://a.example', page('PAGE A')], ['https://b.example', page('paywall')]],
        ownVerdicts: ['NOT SUPPORTED', 'SOURCE UNAVAILABLE'],
    });
    const input = {};
    h.severityInputs.set(h.reportResults[0], input);
    await h.verifyGroupCollective(citations[1], citations, 0, 0, 0, 0);
    assert.equal(h.groupCalls, 0);
    assert.equal(input.unreadSources, true);
});
