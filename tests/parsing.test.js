import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerificationResult } from '../core/parsing.js';

test('parses bare JSON', () => {
  const raw = JSON.stringify({ verdict: 'SUPPORTED', support_score: 'High', comments: 'ok' });
  const out = parseVerificationResult(raw);
  assert.equal(out.verdict, 'SUPPORTED');
  assert.equal(out.support_score, 'High');
});

test('parses JSON inside ```json code fence', () => {
  const raw = '```json\n{"verdict":"NOT SUPPORTED","support_score":"Medium","comments":"c"}\n```';
  const out = parseVerificationResult(raw);
  assert.equal(out.verdict, 'NOT SUPPORTED');
});

test('parses JSON surrounded by prose (legacy {...} extraction)', () => {
  const raw = 'Here is my answer:\n{"verdict":"SUPPORTED","support_score":80,"comments":"matches"}\nThanks.';
  const out = parseVerificationResult(raw);
  assert.equal(out.verdict, 'SUPPORTED');
  assert.equal(out.support_score, 80);
});

test('recovers verdict from Granite-style **Verdict:** SUPPORTED prose', () => {
  const raw = `**Step-by-step verification**

1. **Identify the claim's specific assertions**
   - …

2. **Locate the relevant passage in the article body**
   > "…"

**Verdict:** SUPPORTED
**Comments:** "…" Both the date and the founder match.
`;
  const out = parseVerificationResult(raw);
  assert.equal(out.verdict, 'SUPPORTED');
  assert.equal(out.support_score, null);
  assert.match(out.comments, /non-JSON/);
});

test('fallback recovery is case-insensitive on the "verdict" keyword (lowercase)', () => {
  const raw = '**verdict:** SUPPORTED\n**comments:** ok';
  const out = parseVerificationResult(raw);
  assert.equal(out.verdict, 'SUPPORTED');
});

test('fallback recovery is case-insensitive on the "verdict" keyword (uppercase)', () => {
  const raw = '**VERDICT:** SUPPORTED\n**COMMENTS:** ok';
  const out = parseVerificationResult(raw);
  assert.equal(out.verdict, 'SUPPORTED');
});

test('fallback preserves two-word verdict (NOT SUPPORTED)', () => {
  const raw = `**Verdict:** NOT SUPPORTED
**Comments:** The source contradicts the claim.`;
  const out = parseVerificationResult(raw);
  assert.equal(out.verdict, 'NOT SUPPORTED');
});

test('fallback preserves PARTIALLY SUPPORTED', () => {
  const raw = '**Verdict:** PARTIALLY SUPPORTED\nReasoning: hedged.';
  const out = parseVerificationResult(raw);
  assert.equal(out.verdict, 'PARTIALLY SUPPORTED');
});

test('returns PARSE_ERROR sentinel on pure prose with no verdict marker', () => {
  const out = parseVerificationResult('I cannot determine whether this claim is accurate.');
  assert.equal(out.verdict, 'PARSE_ERROR');
  assert.equal(out.support_score, null);
  assert.match(out.comments, /Failed to parse/);
});

test('returns PARSE_ERROR sentinel on completely malformed input', () => {
  const out = parseVerificationResult('not json at all');
  assert.equal(out.verdict, 'PARSE_ERROR');
  assert.equal(out.support_score, null);
  assert.match(out.comments, /Failed to parse/);
});

test('extracts reason_type from NOT SUPPORTED JSON response', () => {
  const raw = JSON.stringify({
    verdict: 'NOT SUPPORTED',
    support_score: 15,
    reason_type: 'contradiction',
    comments: 'Source says 2002, not 1998.'
  });
  const out = parseVerificationResult(raw);
  assert.equal(out.verdict, 'NOT SUPPORTED');
  assert.equal(out.reason_type, 'contradiction');
});

test('reason_type defaults to null when not present', () => {
  const raw = JSON.stringify({
    verdict: 'SUPPORTED',
    support_score: 90,
    comments: 'Matches.'
  });
  const out = parseVerificationResult(raw);
  assert.equal(out.reason_type, null);
});

// --- source_quote (structured evidence field) ---

test('parses source_quote from the JSON response', () => {
  const raw = JSON.stringify({
    verdict: 'SUPPORTED',
    support_score: 90,
    source_quote: 'Acme Corp was established in 1985.',
    comments: 'Definitive match.',
  });
  assert.equal(parseVerificationResult(raw).source_quote, 'Acme Corp was established in 1985.');
});

test('source_quote accepts camelCase and bare "quote" aliases', () => {
  for (const key of ['sourceQuote', 'quote']) {
    const raw = JSON.stringify({ verdict: 'SUPPORTED', [key]: 'the passage', comments: '' });
    assert.equal(parseVerificationResult(raw).source_quote, 'the passage', `alias ${key}`);
  }
});

test('source_quote defaults to empty string when absent or non-string', () => {
  for (const raw of [
    JSON.stringify({ verdict: 'SUPPORTED', comments: 'c' }),
    JSON.stringify({ verdict: 'SUPPORTED', source_quote: null, comments: 'c' }),
    JSON.stringify({ verdict: 'SUPPORTED', source_quote: 42, comments: 'c' }),
  ]) {
    assert.equal(parseVerificationResult(raw).source_quote, '');
  }
});

test('source_quote is trimmed', () => {
  const raw = JSON.stringify({ verdict: 'SUPPORTED', source_quote: '  padded quote text  ', comments: '' });
  assert.equal(parseVerificationResult(raw).source_quote, 'padded quote text');
});

test('non-JSON and unparseable responses still expose an empty source_quote', () => {
  assert.equal(parseVerificationResult('**Verdict:** SUPPORTED').source_quote, '');
  assert.equal(parseVerificationResult('total gibberish').source_quote, '');
});
