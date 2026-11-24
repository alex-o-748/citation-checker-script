import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ADJUDICATOR_VERSION,
    ATTRIBUTION_CAUSES,
    CAUSE_BRIEF_SECTION,
    MAX_SOURCE_CHARS,
    LABEL_STATUSES,
    blindSystemPrompt,
    blindUserContent,
    attributionSystemPrompt,
    adjudicateCase,
    proposeLabel,
    parseBlindResponse,
    parseAttributionResponse,
    extractJson,
} from '../feedback-loop/adjudicate.js';
import { normalizeCase } from '../feedback-loop/cases.js';

const SOURCE = 'Drought report. Australia could experience more severe droughts and they could become more frequent in the future because of climate change, a government-commissioned report said on Sunday. The report was released in Canberra.';

function makeCase(overrides = {}) {
    return normalizeCase({
        check_id: 'aaaa0001',
        rating: -1,
        corrected_verdict: 'SUPPORTED',
        last_feedback_at: '2026-11-01T10:00:02+00:00',
        kind: 'source',
        article_url: 'https://en.wikipedia.org/wiki/Drought',
        article_title: 'Drought',
        revision_id: 1369727979,
        citation_number: '13',
        source_url: 'https://example.org/report',
        provider: 'huggingface',
        model: 'openai/gpt-oss-20b',
        verdict: 'NOT SUPPORTED',
        reason_type: 'omission',
        claim_text: 'Australia could experience more severe droughts, a report said.',
        llm_comments: 'TOOL-RATIONALE: the source does not mention the date.',
        source_quote: null,
        quote_status: 'empty',
        ...overrides,
    });
}

// A stub model: returns the queued responses in order and records what it saw.
function stubModel(...responses) {
    const calls = [];
    const callModel = async req => {
        calls.push(req);
        const next = responses.shift();
        if (next === undefined) throw new Error(`unexpected ${req.purpose} call`);
        return { text: typeof next === 'string' ? next : JSON.stringify(next), usage: { input: 100, output: 10 } };
    };
    return { calls, callModel };
}

const BLIND_SUPPORTED = {
    verdict: 'SUPPORTED', reason_type: null,
    evidence_quote: 'Australia could experience more severe droughts and they could become more frequent in the future',
    explanation: 'The report says this directly.',
};
const ATTRIBUTION_MISSED = {
    cause: 'citation_metadata', tool_verdict_correct: false, editor_correct: true,
    explanation: 'The checker wanted a date the dateline gives.',
};

test('the blind call sees neither the tool\'s verdict nor the editor\'s', async () => {
    const { calls, callModel } = stubModel(BLIND_SUPPORTED, ATTRIBUTION_MISSED);
    await adjudicateCase(makeCase(), { sourceText: SOURCE, callModel });
    const blind = calls.find(c => c.purpose === 'blind');
    assert.ok(!blind.userContent.includes('TOOL-RATIONALE'), 'tool rationale leaked into the blind call');
    assert.ok(!/NOT SUPPORTED|thumbs|editor/i.test(blind.userContent), 'a verdict or the editor leaked into the blind call');
    assert.ok(blind.userContent.includes('https://example.org/report'), 'the URL is part of the source');
});

test('when everyone agrees, the attribution call is skipped', async () => {
    const c = makeCase({ rating: 1, corrected_verdict: null, verdict: 'SUPPORTED', reason_type: null });
    const { calls, callModel } = stubModel(BLIND_SUPPORTED);
    const adj = await adjudicateCase(c, { sourceText: SOURCE, callModel });
    assert.equal(calls.length, 1);
    assert.equal(adj.attribution.cause, ATTRIBUTION_CAUSES.TOOL_CORRECT);
    assert.equal(adj.usage.calls, 1);
    assert.equal(proposeLabel(c, adj).labelStatus, LABEL_STATUSES.AGREED);
});

test('editor and blind reading agree, evidence verifies: the label is agreed', async () => {
    const c = makeCase();
    const { calls, callModel } = stubModel(BLIND_SUPPORTED, ATTRIBUTION_MISSED);
    const adj = await adjudicateCase(c, { sourceText: SOURCE, callModel, hints: ['citation_metadata'], model: 'test-model' });
    assert.equal(calls.length, 2);
    assert.equal(adj.version, ADJUDICATOR_VERSION);
    assert.equal(adj.model, 'test-model');
    assert.equal(adj.blind.quoteStatus, 'exact');
    assert.equal(adj.attribution.cause, 'citation_metadata');
    assert.deepEqual(adj.usage, { input: 200, output: 20, calls: 2 });
    // The attribution call is told about the hints and the blind reading,
    // but is not sent the source again.
    const attribution = calls[1].userContent;
    assert.ok(attribution.includes('citation_metadata'));
    assert.ok(attribution.includes('The report says this directly.'));
    assert.ok(!attribution.includes('The report was released in Canberra'));
    assert.deepEqual(proposeLabel(c, adj), {
        groundTruth: 'Supported', suggestedBy: 'editor', labelStatus: 'agreed', reasons: [], excludedReason: null,
    });
});

test('evidence the source does not contain sends the case to the owner', async () => {
    const c = makeCase();
    const { callModel } = stubModel({ ...BLIND_SUPPORTED, evidence_quote: 'Australia will certainly face droughts every single year.' }, ATTRIBUTION_MISSED);
    const label = proposeLabel(c, await adjudicateCase(c, { sourceText: SOURCE, callModel }));
    assert.equal(label.labelStatus, 'needs_owner');
    assert.match(label.reasons.join(' '), /evidence was not found in the source \(not-found\)/);
});

test('blind reading disagreeing with the editor sends the case to the owner', async () => {
    const c = makeCase();
    const { callModel } = stubModel(
        { verdict: 'NOT SUPPORTED', reason_type: 'omission', evidence_quote: '', explanation: 'Nothing about it.' },
        { cause: 'editor_likely_wrong', tool_verdict_correct: true, editor_correct: false, explanation: 'x' },
    );
    const label = proposeLabel(c, await adjudicateCase(c, { sourceText: SOURCE, callModel }));
    assert.equal(label.labelStatus, 'needs_owner');
    assert.equal(label.groundTruth, 'Supported', 'the editor\'s verdict is still the suggestion');
    assert.match(label.reasons[0], /independent reading says NOT SUPPORTED, the editor SUPPORTED/);
});

test('an unusable page against an editor\'s verdict is kept, but excluded from scoring', async () => {
    const c = makeCase();
    const { callModel } = stubModel(
        { verdict: 'SOURCE UNAVAILABLE', reason_type: null, evidence_quote: '', explanation: 'A login page.' },
        { cause: 'unusable_page', tool_verdict_correct: false, editor_correct: true, explanation: 'x' },
    );
    const label = proposeLabel(c, await adjudicateCase(c, { sourceText: 'Log in to continue. Forgot password?', callModel }));
    assert.equal(label.labelStatus, 'needs_owner');
    assert.equal(label.excludedReason, 'retrieved text is not the cited source (independent reading)');
});

test('a bare thumbs-down takes the adjudicator\'s verdict as the suggestion', async () => {
    const c = makeCase({ corrected_verdict: null });
    const { callModel } = stubModel(BLIND_SUPPORTED, ATTRIBUTION_MISSED);
    const label = proposeLabel(c, await adjudicateCase(c, { sourceText: SOURCE, callModel }));
    assert.equal(label.labelStatus, 'needs_owner');
    assert.equal(label.suggestedBy, 'adjudicator');
    assert.equal(label.groundTruth, 'Supported');
});

test('self-contradicting feedback never produces an agreed label', async () => {
    const c = makeCase({ verdict: 'SUPPORTED', reason_type: null, corrected_verdict: 'SUPPORTED' }); // thumbs-down "corrected" to the same verdict
    const { callModel } = stubModel(BLIND_SUPPORTED, { cause: 'other', explanation: 'x' });
    const label = proposeLabel(c, await adjudicateCase(c, { sourceText: SOURCE, callModel }));
    assert.equal(label.labelStatus, 'needs_owner');
    assert.match(label.reasons[0], /contradicts itself/);
});

test('a tool quote that verified then but not now marks the source as drifted', async () => {
    const c = makeCase({ source_quote: 'A sentence that the page no longer contains at all.', quote_status: 'exact' });
    const { callModel } = stubModel(BLIND_SUPPORTED, ATTRIBUTION_MISSED);
    const adj = await adjudicateCase(c, { sourceText: SOURCE, callModel });
    assert.equal(adj.sourceDrift, true);
    assert.match(proposeLabel(c, adj).reasons.join(' '), /source has changed/);
});

test('parseBlindResponse tolerates fences and canonicalizes, and rejects nonsense', () => {
    const parsed = parseBlindResponse('```json\n{"verdict": "not supported", "reason_type": "contradiction", "evidence_quote": " x ", "explanation": "y"}\n```');
    assert.deepEqual(parsed, { verdict: 'NOT SUPPORTED', reasonType: 'contradiction', evidenceQuote: 'x', explanation: 'y' });
    assert.equal(parseBlindResponse('{"verdict": "NOT SUPPORTED"}').reasonType, 'omission');
    assert.equal(parseBlindResponse('{"verdict": "SUPPORTED", "reason_type": "omission"}').reasonType, null);
    assert.throws(() => parseBlindResponse('{"verdict": "MAYBE"}'), /unrecognized verdict/);
    assert.throws(() => extractJson('no json here'), /no JSON object/);
});

test('parseAttributionResponse keeps an unknown cause visible as "other"', () => {
    const parsed = parseAttributionResponse('Here: {"cause": "cosmic_rays", "tool_verdict_correct": "yes", "editor_correct": false, "explanation": "z"}');
    assert.equal(parsed.cause, 'other');
    assert.equal(parsed.claimedCause, 'cosmic_rays');
    assert.equal(parsed.toolVerdictCorrect, null, 'non-booleans are not guessed');
    assert.equal(parsed.editorCorrect, false);
});

test('a source longer than the cap is cut and the reviewer is told so', () => {
    const content = blindUserContent({ claimText: 'c', sourceUrl: 'u', sourceText: 'x'.repeat(MAX_SOURCE_CHARS + 50) });
    assert.match(content, /cut off at a length limit/);
    assert.ok(content.length < MAX_SOURCE_CHARS + 500);
});

test('every attribution cause is described to the model and mapped to the brief', () => {
    const prompt = attributionSystemPrompt();
    for (const id of Object.values(ATTRIBUTION_CAUSES)) {
        assert.ok(prompt.includes(`- ${id}: `), `${id} is not described in the prompt`);
        assert.ok(Object.hasOwn(CAUSE_BRIEF_SECTION, id), `${id} has no brief section`);
    }
});

test('the blind prompt states the framework\'s four verdicts', () => {
    const prompt = blindSystemPrompt();
    for (const v of ['SUPPORTED', 'PARTIALLY SUPPORTED', 'NOT SUPPORTED', 'SOURCE UNAVAILABLE']) assert.ok(prompt.includes(v));
});
