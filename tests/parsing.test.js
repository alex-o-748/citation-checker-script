import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerificationResult } from '../core/parsing.js';

test('parses bare JSON', () => {
  const raw = JSON.stringify({ verdict: 'SUPPORTED', confidence: 'High', comments: 'ok' });
  const out = parseVerificationResult(raw);
  assert.equal(out.verdict, 'SUPPORTED');
  assert.equal(out.confidence, 'High');
});

test('parses JSON inside ```json code fence', () => {
  const raw = '```json\n{"verdict":"NOT SUPPORTED","confidence":"Medium","comments":"c"}\n```';
  const out = parseVerificationResult(raw);
  assert.equal(out.verdict, 'NOT SUPPORTED');
});

test('parses JSON surrounded by prose (legacy {...} extraction)', () => {
  const raw = 'Here is my answer:\n{"verdict":"SUPPORTED","confidence":80,"comments":"matches"}\nThanks.';
  const out = parseVerificationResult(raw);
  assert.equal(out.verdict, 'SUPPORTED');
  assert.equal(out.confidence, 80);
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
  assert.equal(out.confidence, null);
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
  assert.equal(out.confidence, null);
  assert.match(out.comments, /Failed to parse/);
});

test('returns PARSE_ERROR sentinel on completely malformed input', () => {
  const out = parseVerificationResult('not json at all');
  assert.equal(out.verdict, 'PARSE_ERROR');
  assert.equal(out.confidence, null);
  assert.match(out.comments, /Failed to parse/);
});
