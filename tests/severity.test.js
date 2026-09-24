import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
    generateSeveritySystemPrompt, generateSeverityUserPrompt, parseSeverityResult,
    tierFor, compareSeverity, SEVERITY_TIERS, SEVERITY_TIER_ORDER, SEVERITY_PROMPT_VERSION,
} from '../core/severity.js';

const sc = (status, central = true) => ({ text: 'x', status, central });

// Same contract as tests/prompts.test.js's PROMPT_VERSION pin: severity labels
// from two prompt revisions are not comparable, and the CSV's
// severity_prompt_version column only tells them apart if the version moves.
// On a deliberate prompt change: bump SEVERITY_PROMPT_VERSION in
// core/severity.js and replace EXPECTED_HASH with the reported value.
test('SEVERITY_PROMPT_VERSION is bumped whenever the severity prompt changes', () => {
    const EXPECTED_HASH = '1dc7da2863d97f362e4fc7d98fc6c4da3aaf25b0464cd4d8a93fff55894108e9';
    const actual = createHash('sha256').update(generateSeveritySystemPrompt(), 'utf8').digest('hex');
    assert.equal(actual, EXPECTED_HASH,
        `generateSeveritySystemPrompt() changed (hash now ${actual}) but SEVERITY_PROMPT_VERSION is still ` +
        `"${SEVERITY_PROMPT_VERSION}". Bump it and update EXPECTED_HASH.`);
});

test('the prompt keeps status source-only and context for centrality only', () => {
    const prompt = generateSeveritySystemPrompt();
    assert.match(prompt, /Decide status ONLY from the source text/);
    assert.match(prompt, /Never use the article context as evidence/);
    assert.match(prompt, /Use the article title, section and paragraph to judge this/);
});

test('the user prompt carries the context, marks the lead, and never the first-pass verdict', () => {
    const withSection = generateSeverityUserPrompt({
        claimText: 'The bridge opened in 1998.',
        sourceInfo: 'Source URL: https://x.example\n\nSource Content:\nIt opened in 2002.',
        articleTitle: 'Riverside Bridge', sectionTitle: 'History', paragraphText: 'The bridge opened in 1998. It cost a lot.',
    });
    assert.match(withSection, /^Article: Riverside Bridge$/m);
    assert.match(withSection, /^Section: History$/m);
    assert.match(withSection, /^Paragraph \(context only, not evidence\): The bridge opened in 1998\. It cost a lot\.$/m);
    assert.match(withSection, /Source text:\nIt opened in 2002\.$/, 'fetch header stripped, as in the verdict prompt');
    assert.doesNotMatch(withSection, /SUPPORTED|verdict/i);

    const lead = generateSeverityUserPrompt({ claimText: 'c', sourceInfo: 's', sectionTitle: null });
    assert.match(lead, /^Section: \(lead section\)$/m);
    assert.doesNotMatch(lead, /Paragraph/);
});

test('parseSeverityResult accepts fenced JSON, a bare array, and normalizes status case', () => {
    const fenced = parseSeverityResult('Here:\n```json\n{"subclaims":[{"text":"a","status":"Contradicted","central":true}]}\n```');
    assert.deepEqual(fenced, { ok: true, subclaims: [{ text: 'a', status: 'contradicted', central: true }] });
    const bare = parseSeverityResult('[{"text":"a","status":"absent","central":false}]');
    assert.deepEqual(bare.subclaims, [{ text: 'a', status: 'absent', central: false }]);
});

test('parseSeverityResult treats a missing or odd `central` as central — can rank higher, never bury', () => {
    const r = parseSeverityResult('{"subclaims":[{"text":"a","status":"absent"},{"text":"b","status":"absent","central":"false"}]}');
    assert.deepEqual(r.subclaims.map(s => s.central), [true, false]);
});

test('parseSeverityResult refuses what it cannot tier', () => {
    assert.deepEqual(parseSeverityResult('not json'), { ok: false, error: 'parse_error' });
    assert.deepEqual(parseSeverityResult('{"subclaims":[]}'), { ok: false, error: 'no_subclaims' });
    assert.deepEqual(parseSeverityResult('{"verdict":"x"}'), { ok: false, error: 'no_subclaims' });
    assert.deepEqual(parseSeverityResult('{"subclaims":[{"text":"a","status":"partly"}]}'), { ok: false, error: 'bad_status' });
});

test('tierFor: contradiction outranks absence, centrality outranks peripherality', () => {
    const { CENTRAL_CONTRADICTED, CENTRAL_ABSENT, PERIPHERAL_ABSENT, DISAGREEMENT } = SEVERITY_TIERS;
    assert.equal(tierFor({ subclaims: [sc('contradicted'), sc('absent')] }), CENTRAL_CONTRADICTED);
    assert.equal(tierFor({ subclaims: [sc('contradicted', false), sc('supported')] }), CENTRAL_ABSENT);
    assert.equal(tierFor({ subclaims: [sc('absent'), sc('supported')] }), CENTRAL_ABSENT);
    assert.equal(tierFor({ subclaims: [sc('supported'), sc('absent', false)] }), PERIPHERAL_ABSENT);
    assert.equal(tierFor({ subclaims: [sc('supported'), sc('supported', false)] }), DISAGREEMENT);
});

test('tierFor: truncation discounts absence but never a contradiction', () => {
    const { CENTRAL_CONTRADICTED, CENTRAL_ABSENT, DISCOUNTED } = SEVERITY_TIERS;
    const t = subclaims => tierFor({ subclaims, sourceTruncated: true });
    assert.equal(t([sc('absent')]), DISCOUNTED);
    assert.equal(t([sc('absent', false)]), DISCOUNTED);
    assert.equal(t([sc('contradicted'), sc('absent')]), CENTRAL_CONTRADICTED);
    assert.equal(t([sc('contradicted', false), sc('absent')]), CENTRAL_ABSENT);
});

test('compareSeverity orders by tier, then BLP, then lower support score; untiered last', () => {
    const findings = [
        { id: 'untiered', severityTier: null, isBlp: true, supportScore: 0 },
        { id: 't2', severityTier: 'T2', isBlp: false, supportScore: 10 },
        { id: 't1-low', severityTier: 'T1', isBlp: false, supportScore: 5 },
        { id: 't1-blp', severityTier: 'T1', isBlp: true, supportScore: 30 },
        { id: 't1-high', severityTier: 'T1', isBlp: null, supportScore: 20 },
        { id: 'disagree', severityTier: 'disagreement', isBlp: true, supportScore: 0 },
    ];
    assert.deepEqual(
        [...findings].sort(compareSeverity).map(f => f.id),
        ['t1-blp', 't1-low', 't1-high', 't2', 'disagree', 'untiered']
    );
});

test('SEVERITY_TIER_ORDER lists every tier exactly once', () => {
    assert.deepEqual([...SEVERITY_TIER_ORDER].sort(), Object.values(SEVERITY_TIERS).sort());
});
