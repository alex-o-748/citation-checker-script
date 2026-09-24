import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assessSeverity, needsSeverity } from '../service/severity-assessor.js';
import { ProviderAuthError } from '../service/verifier.js';
import { SEVERITY_PROMPT_VERSION } from '../core/severity.js';

const flagged = { verdict: 'NOT SUPPORTED', reasonType: 'contradiction' };
const reply = subclaims => async () => ({ text: JSON.stringify({ subclaims }), usage: { input: 1, output: 1 } });
const args = (over = {}) => ({
    claimText: 'The bridge opened in 1998.', sourceInfo: 'It opened in 2002.', sourceTruncated: false,
    verification: flagged, articleTitle: 'Riverside Bridge', sectionTitle: 'History', paragraphText: 'p',
    ...over,
});
const noRetry = { maxRetries: 1, sleepFn: async () => {} };

test('needsSeverity: only flags are ranked', () => {
    assert.equal(needsSeverity({ verdict: 'NOT SUPPORTED' }), true);
    assert.equal(needsSeverity({ verdict: 'PARTIALLY SUPPORTED' }), true);
    for (const verdict of ['SUPPORTED', 'SOURCE UNAVAILABLE', 'SKIPPED', 'ERROR']) {
        assert.equal(needsSeverity({ verdict }), false, verdict);
    }
    assert.equal(needsSeverity(null), false);
});

test('a parsed answer is tiered and records the prompt version', async () => {
    let seen;
    const callModel = async (system, user) => {
        seen = { system, user };
        return reply([{ text: 'opened in 1998', status: 'contradicted', central: true }])();
    };
    const r = await assessSeverity(args(), { callModel });
    assert.equal(r.tier, 'T1');
    assert.equal(r.error, null);
    assert.equal(r.promptVersion, SEVERITY_PROMPT_VERSION);
    assert.match(seen.user, /Section: History/);
});

test('a truncated pure omission is discounted without a model call', async () => {
    let called = false;
    const r = await assessSeverity(
        args({ sourceTruncated: true, verification: { verdict: 'NOT SUPPORTED', reasonType: 'omission' } }),
        { callModel: async () => { called = true; } }
    );
    assert.equal(called, false);
    assert.equal(r.tier, 'discounted');
    assert.equal(r.promptVersion, undefined, 'no prompt ran, so no version is claimed');
});

test('a truncated PARTIAL still gets the pass — a contradiction would survive truncation', async () => {
    const r = await assessSeverity(
        args({ sourceTruncated: true, verification: { verdict: 'PARTIALLY SUPPORTED', reasonType: null } }),
        { callModel: reply([{ text: 'a', status: 'contradicted', central: true }]) }
    );
    assert.equal(r.tier, 'T1');
});

test('an unparseable answer is recorded untiered, not thrown', async () => {
    const r = await assessSeverity(args(), { callModel: async () => ({ text: 'I think it is bad', usage: {} }) });
    assert.equal(r.tier, null);
    assert.equal(r.error, 'parse_error');
});

test('auth/billing errors throw ProviderAuthError so the runner halts', async () => {
    await assert.rejects(
        assessSeverity(args(), { callModel: async () => { throw new Error('API request failed (402): wallet'); }, retry: noRetry }),
        ProviderAuthError
    );
});

test('a source too large for the context window is recorded, not thrown', async () => {
    const r = await assessSeverity(args(), {
        callModel: async () => { throw new Error("API request failed (400): This model's maximum context length is 32768 tokens"); },
        retry: noRetry,
    });
    assert.equal(r.tier, null);
    assert.equal(r.error, 'source_too_large');
});
