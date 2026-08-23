import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    verifyCitation,
    isAuthOrBillingError,
    ProviderAuthError,
    makeModelCaller,
} from '../service/verify.js';

const okResponse = (body) => async () => ({
    text: JSON.stringify(body),
    usage: { input: 120, output: 30 },
});

const source = (content, extra = {}) => ({ content, status: 200, error: null, ...extra });

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
            confidence: 95,
            verdict: 'SUPPORTED',
            source_quote: 'Acme Corp was founded in 1985 by John Smith.',
            comments: 'Direct match.',
        }),
    });

    assert.equal(result.verdict, 'SUPPORTED');
    assert.equal(result.confidence, 95);
    assert.equal(result.quoteStatus, 'exact');
    assert.equal(result.sourceQuote, 'Acme Corp was founded in 1985 by John Smith.');
    assert.deepEqual(result.usage, { input: 120, output: 30 });
});

test('a quote the source does not contain is still recorded, with its own status', async () => {
    const src = source('Source URL: https://example.com\n\nSource Content:\nAcme Corp was founded in 1985.');
    const result = await verifyCitation('The company was founded by John Smith.', src, {
        callModel: okResponse({
            confidence: 40,
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
            return { text: JSON.stringify({ confidence: 80, verdict: 'SUPPORTED', source_quote: '', comments: 'ok' }), usage: {} };
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
