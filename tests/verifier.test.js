import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    verifyCitation,
    verifyGroup,
    isAuthOrBillingError,
    ProviderAuthError,
    makeModelCaller,
} from '../service/verifier.js';
import { PROMPT_LANGUAGES } from '../core/prompts.js';

const okResponse = (body) => async () => ({
    text: JSON.stringify(body),
    usage: { input: 120, output: 30 },
});

const source = (content, extra = {}) => ({ content, status: 200, error: null, ...extra });

const withContent = body => `Source URL: https://example.com\n\nSource Content:\n${body}`;

// One member of an adjacent-citation group, in the shape
// service/claim-extractor.js's processArticle() produces.
const member = (citationNumber, { url = `https://example.com/${citationNumber}`, pageNum = null, content = null, status = 200, error = null, groupId = 'g1', groupSize = 2, groupIndex = 0 } = {}) => ({
    citationNumber,
    claimText: 'The bridge, built in 1998, cost $200 million.',
    url,
    pageNum,
    groupId,
    groupSize,
    groupIndex,
    source: { content, status, error },
});

test('a no-URL / unfetched source resolves to SOURCE UNAVAILABLE without calling the model', async () => {
    let called = false;
    const result = await verifyCitation('The bridge opened in 1998.', { content: null, status: null }, {
        callModel: async () => { called = true; return { text: '{}', usage: {} }; },
    });

    assert.equal(result.verdict, 'SOURCE UNAVAILABLE');
    assert.equal(result.usage, null);
    assert.equal(result.quoteStatus, null);
    assert.equal(called, false, 'no source content means nothing to send to the model');
});

test('a fetch failure carries its status through untouched', async () => {
    const result = await verifyCitation('claim', { content: null, status: 403 }, {
        callModel: async () => ({ text: '{}', usage: {} }),
    });
    assert.equal(result.fetchStatus, 403, '403 must stay distinguishable from a dead link');
});

test('a supported verdict carries a verified quote', async () => {
    const src = source('Source URL: https://example.com\n\nSource Content:\nAcme Corp was founded in 1985 by John Smith.');
    const result = await verifyCitation('The company was founded in 1985 by John Smith.', src, {
        callModel: okResponse({
            support_score: 95,
            verdict: 'SUPPORTED',
            source_quote: 'Acme Corp was founded in 1985 by John Smith.',
            comments: 'Direct match.',
        }),
    });

    assert.equal(result.verdict, 'SUPPORTED');
    assert.equal(result.supportScore, 95);
    assert.equal(result.quoteStatus, 'exact');
    assert.equal(result.sourceQuote, 'Acme Corp was founded in 1985 by John Smith.');
    assert.deepEqual(result.usage, { input: 120, output: 30 });
});

test('verifyCitation localizes the system prompt when langCode is given', async () => {
    const src = source('Source URL: https://example.com\n\nSource Content:\nAcme Corp was founded in 1985.');
    let seenSystemPrompt;
    await verifyCitation('The company was founded in 1985.', src, {
        langCode: 'ru',
        callModel: async (systemPrompt, userContent) => {
            seenSystemPrompt = systemPrompt;
            return { text: JSON.stringify({ support_score: 90, verdict: 'SUPPORTED', source_quote: '', comments: '' }), usage: {} };
        },
    });
    assert.ok(seenSystemPrompt.includes(PROMPT_LANGUAGES.ru), 'system prompt must carry the Russian language directive');
});

test('verifyCitation leaves the system prompt in English when langCode is omitted', async () => {
    const src = source('Source URL: https://example.com\n\nSource Content:\nAcme Corp was founded in 1985.');
    let seenSystemPrompt;
    await verifyCitation('The company was founded in 1985.', src, {
        callModel: async (systemPrompt, userContent) => {
            seenSystemPrompt = systemPrompt;
            return { text: JSON.stringify({ support_score: 90, verdict: 'SUPPORTED', source_quote: '', comments: '' }), usage: {} };
        },
    });
    assert.doesNotMatch(seenSystemPrompt, /LANGUAGE:/, 'no langCode means the prompt is unchanged');
});

test('a quote the source does not contain is still recorded, with its own status', async () => {
    const src = source('Source URL: https://example.com\n\nSource Content:\nAcme Corp was founded in 1985.');
    const result = await verifyCitation('The company was founded by John Smith.', src, {
        callModel: okResponse({
            support_score: 40,
            verdict: 'NOT SUPPORTED',
            reason_type: 'omission',
            source_quote: 'John Smith personally founded the company.',
            comments: 'Fabricated — not in the source.',
        }),
    });

    // Per CLAUDE.md: the log/store layer keeps a not-found quote rather than
    // discarding it — that is the row worth inspecting later.
    assert.equal(result.sourceQuote, 'John Smith personally founded the company.');
    assert.equal(result.quoteStatus, 'not-found');
});

test('a malformed model response surfaces as the PARSE_ERROR sentinel, not a throw', async () => {
    const src = source('Source URL: https://example.com\n\nSource Content:\nSome text.');
    const result = await verifyCitation('claim', src, {
        callModel: async () => ({ text: 'not json at all', usage: { input: 5, output: 5 } }),
    });
    assert.equal(result.verdict, 'PARSE_ERROR');
});

test('a transient 503 is retried and eventually succeeds', async () => {
    let attempts = 0;
    const src = source('Source URL: https://example.com\n\nSource Content:\nSome text about a bridge.');
    const result = await verifyCitation('claim', src, {
        callModel: async () => {
            attempts++;
            if (attempts < 3) throw new Error('PublicAI API request failed (503): upstream unavailable');
            return { text: JSON.stringify({ support_score: 80, verdict: 'SUPPORTED', source_quote: '', comments: 'ok' }), usage: {} };
        },
        retry: { maxRetries: 5, minBackoffMs: 0, maxBackoffMs: 0, jitterMs: 0, sleepFn: async () => {} },
    });

    assert.equal(attempts, 3);
    assert.equal(result.verdict, 'SUPPORTED');
});

for (const status of [401, 402, 403]) {
    test(`a ${status} from the model halts with ProviderAuthError rather than retrying`, async () => {
        let attempts = 0;
        const src = source('Source URL: https://example.com\n\nSource Content:\nSome text.');
        await assert.rejects(
            () => verifyCitation('claim', src, {
                callModel: async () => {
                    attempts++;
                    throw new Error(`PublicAI API request failed (${status}): insufficient wallet balance`);
                },
                retry: { maxRetries: 5, minBackoffMs: 0, maxBackoffMs: 0, jitterMs: 0, sleepFn: async () => {} },
            }),
            ProviderAuthError
        );
        assert.equal(attempts, 1, 'an auth/billing error must not be retried');
    });
}

test('a context-length-exceeded failure resolves to a per-citation ERROR result, not a throw, and is not retried', async () => {
    let attempts = 0;
    const src = source('Source URL: https://example.com\n\nSource Content:\nSome very long text about a bridge.');
    const result = await verifyCitation('claim', src, {
        callModel: async () => {
            attempts++;
            throw new Error(
                'Lift Wing API request failed (500): {"error":"VLLMValidationError : This model\'s maximum context ' +
                'length is 32768 tokens. However, you requested 0 output tokens and your prompt contains at least ' +
                '32769 input tokens, for a total of at least 32769 tokens."}'
            );
        },
        retry: { maxRetries: 5, minBackoffMs: 0, maxBackoffMs: 0, jitterMs: 0, sleepFn: async () => {} },
    });

    assert.equal(attempts, 1, 'a context-length failure is permanent for this exact prompt — retrying it is pointless');
    assert.equal(result.verdict, 'ERROR');
    assert.equal(result.reasonType, 'context_length');
    assert.match(result.rationale, /maximum context length/);
    assert.equal(result.usage, null, 'no tokens were actually generated');
    assert.equal(result.sourceQuote, null);
    assert.equal(result.quoteStatus, null);
});

test('a proxy 413 ("source too large to send") also resolves to a per-citation ERROR, not a run-halting throw', async () => {
    // Regression for a real ruwiki sweep, 2026-08-31: this is a *different*
    // message shape than the vLLM context-length case above (a CORS-proxy
    // request-body cap, thrown by core/providers.js on a raw 413 — see that
    // file's own comment), and it was NOT recognized by isContextLengthError,
    // so it fell through to a run-halting throw after 202 findings were
    // already computed. Same practical failure ("this source can never be
    // sent"), so it must degrade the same way.
    let attempts = 0;
    const src = source('Source URL: https://example.com\n\nSource Content:\nSome very long text about a bridge.');
    const result = await verifyCitation('claim', src, {
        callModel: async () => {
            attempts++;
            throw new Error(
                'Lift Wing: the source is too large to send. Trim the source text, or switch to a provider ' +
                'that calls its API directly (Claude, Gemini, or OpenAI).'
            );
        },
        retry: { maxRetries: 5, minBackoffMs: 0, maxBackoffMs: 0, jitterMs: 0, sleepFn: async () => {} },
    });

    assert.equal(attempts, 1, 'a 413 is permanent for this exact source — retrying it is pointless');
    assert.equal(result.verdict, 'ERROR');
    assert.equal(result.reasonType, 'context_length');
    assert.match(result.rationale, /too large to send/);
    assert.equal(result.usage, null);
});

test('verifyGroup: a proxy 413 ("source too large to send") also resolves to a per-group ERROR, not a throw', async () => {
    const members = [
        member('5', { groupIndex: 0, url: 'https://a.example', content: withContent('A'.repeat(200)) }),
        member('6', { groupIndex: 1, url: 'https://b.example', content: withContent('B'.repeat(200)) }),
    ];
    const result = await verifyGroup(members, {
        callModel: async () => {
            throw new Error('Lift Wing: the source is too large to send. Trim the source text, or switch to a provider that calls its API directly (Claude, Gemini, or OpenAI).');
        },
        retry: { maxRetries: 5, minBackoffMs: 0, maxBackoffMs: 0, jitterMs: 0, sleepFn: async () => {} },
    });

    assert.equal(result.skipped, false);
    assert.equal(result.verdict, 'ERROR');
    assert.equal(result.reasonType, 'context_length');
});

test('verifyGroup: a context-length-exceeded failure resolves to a per-group ERROR result, not a throw', async () => {
    const members = [
        member('5', { groupIndex: 0, url: 'https://a.example', content: withContent('A'.repeat(200)) }),
        member('6', { groupIndex: 1, url: 'https://b.example', content: withContent('B'.repeat(200)) }),
    ];
    const result = await verifyGroup(members, {
        callModel: async () => {
            throw new Error('Lift Wing API request failed (500): VLLMValidationError: maximum context length is 32768 tokens');
        },
        retry: { maxRetries: 5, minBackoffMs: 0, maxBackoffMs: 0, jitterMs: 0, sleepFn: async () => {} },
    });

    assert.equal(result.skipped, false);
    assert.equal(result.verdict, 'ERROR');
    assert.equal(result.reasonType, 'context_length');
    assert.equal(result.groupId, 'g1');
    assert.deepEqual(result.memberCitationNumbers, ['5', '6']);
    assert.equal(result.usage, null);
});

test('isAuthOrBillingError is narrower than a generic 4xx', () => {
    assert.equal(isAuthOrBillingError(new Error('API request failed (402): no balance')), true);
    assert.equal(isAuthOrBillingError(new Error('API request failed (429): rate limited')), false);
    assert.equal(isAuthOrBillingError(new Error('API request failed (400): bad request')), false);
    assert.equal(isAuthOrBillingError(new Error('socket hang up')), false);
});

test('verifyCitation requires a callModel function', async () => {
    await assert.rejects(
        () => verifyCitation('claim', source('x'), {}),
        TypeError
    );
});

test('makeModelCaller binds provider config without leaking it into the returned function signature', async () => {
    let seenConfig;
    // Swap in a fake by constructing the caller from a fake callProviderAPI
    // is not possible without module mocking, so this test instead checks
    // the returned function's arity/shape contract that verifyCitation relies
    // on: two positional args in, a promise of {text, usage} out.
    const caller = makeModelCaller({ provider: 'claude', apiKey: 'k', model: 'm' });
    assert.equal(typeof caller, 'function');
    assert.equal(caller.length, 2, 'callModel must accept (systemPrompt, userContent)');
});

test('makeModelCaller requires a provider name', () => {
    assert.throws(() => makeModelCaller({}), TypeError);
});

test('verifyGroup skips the model call when at most one member has a usable source', async () => {
    let called = false;
    const members = [
        member('5', { groupIndex: 0, content: withContent('some text'), status: 200 }),
        member('6', { groupIndex: 1, content: null, status: 403, error: 'forbidden' }),
    ];
    const result = await verifyGroup(members, {
        callModel: async () => { called = true; return { text: '{}', usage: {} }; },
    });
    assert.deepEqual(result, { skipped: true, groupId: 'g1' });
    assert.equal(called, false, 'a group with <=1 usable source must not call the model');
});

test('verifyGroup calls the model with assembled sources when two or more are usable', async () => {
    const members = [
        member('5', { groupIndex: 0, url: 'https://a.example', content: withContent('The bridge opened in 1998.') }),
        member('6', { groupIndex: 1, url: 'https://b.example', content: withContent('Funding came from state and federal grants.') }),
    ];
    const result = await verifyGroup(members, {
        callModel: okResponse({
            support_score: 88,
            verdict: 'PARTIALLY SUPPORTED',
            source_quote: 'The bridge opened in 1998.',
            comments: 'Only the date is confirmed.',
        }),
    });

    assert.equal(result.skipped, false);
    assert.equal(result.groupId, 'g1');
    assert.deepEqual(result.memberCitationNumbers, ['5', '6']);
    assert.equal(result.verdict, 'PARTIALLY SUPPORTED');
    assert.equal(result.quoteStatus, 'exact');
    assert.deepEqual(result.usage, { input: 120, output: 30 });
});

test('verifyGroup localizes the system prompt when langCode is given', async () => {
    const members = [
        member('5', { groupIndex: 0, url: 'https://a.example', content: withContent('The bridge opened in 1998.') }),
        member('6', { groupIndex: 1, url: 'https://b.example', content: withContent('Funding came from state and federal grants.') }),
    ];
    let seenSystemPrompt;
    await verifyGroup(members, {
        langCode: 'ru',
        callModel: async (systemPrompt, userContent) => {
            seenSystemPrompt = systemPrompt;
            return { text: JSON.stringify({ support_score: 80, verdict: 'SUPPORTED', source_quote: '', comments: '' }), usage: {} };
        },
    });
    assert.ok(seenSystemPrompt.includes(PROMPT_LANGUAGES.ru), 'group system prompt must carry the Russian language directive');
});

test('verifyGroup dedupes members sharing the same URL into one source block', async () => {
    const members = [
        member('5', { groupIndex: 0, groupSize: 3, url: 'https://shared.example', content: withContent('Shared source text.') }),
        member('6', { groupIndex: 1, groupSize: 3, url: 'https://shared.example', content: withContent('Shared source text.') }),
        member('7', { groupIndex: 2, groupSize: 3, url: 'https://distinct.example', content: withContent('Distinct source text.') }),
    ];
    let seenUserContent;
    const result = await verifyGroup(members, {
        callModel: async (systemPrompt, userContent) => {
            seenUserContent = userContent;
            return {
                text: JSON.stringify({ support_score: 90, verdict: 'SUPPORTED', source_quote: 'Shared source text.', comments: 'ok' }),
                usage: { input: 1, output: 1 },
            };
        },
    });

    assert.equal(result.skipped, false);
    assert.deepEqual(result.memberCitationNumbers, ['5', '6', '7']);
    assert.match(seenUserContent, /\[5\]\[6\]/, 'both citation numbers label the shared source');
    assert.equal((seenUserContent.match(/Source \[/g) || []).length, 2, 'the shared source contributes one block, not two');
});

test('verifyGroup verifies a quote against any member source, not just the first', async () => {
    const members = [
        member('5', { groupIndex: 0, url: 'https://a.example', content: withContent('Alpha fact only.') }),
        member('6', { groupIndex: 1, url: 'https://b.example', content: withContent('Beta fact confirmed here.') }),
    ];
    const result = await verifyGroup(members, {
        callModel: okResponse({
            support_score: 70,
            verdict: 'PARTIALLY SUPPORTED',
            source_quote: 'Beta fact confirmed here.',
            comments: 'ok',
        }),
    });
    assert.equal(result.quoteStatus, 'exact');
});

for (const status of [401, 402, 403]) {
    test(`verifyGroup halts with ProviderAuthError on a ${status}`, async () => {
        const members = [
            member('5', { groupIndex: 0, url: 'https://a.example', content: withContent('text a') }),
            member('6', { groupIndex: 1, url: 'https://b.example', content: withContent('text b') }),
        ];
        let attempts = 0;
        await assert.rejects(
            () => verifyGroup(members, {
                callModel: async () => {
                    attempts++;
                    throw new Error(`PublicAI API request failed (${status}): insufficient wallet balance`);
                },
                retry: { maxRetries: 5, minBackoffMs: 0, maxBackoffMs: 0, jitterMs: 0, sleepFn: async () => {} },
            }),
            ProviderAuthError
        );
        assert.equal(attempts, 1, 'an auth/billing error must not be retried');
    });
}

test('verifyGroup requires a callModel function', async () => {
    const members = [member('5', { groupIndex: 0, content: withContent('a') })];
    await assert.rejects(() => verifyGroup(members, {}), TypeError);
});

test('verifyGroup requires a non-empty members array', async () => {
    await assert.rejects(
        () => verifyGroup([], { callModel: async () => ({ text: '{}', usage: {} }) }),
        TypeError
    );
});
