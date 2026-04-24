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

test('throws or returns error shape on malformed input', () => {
  const out = parseVerificationResult('not json at all');
  assert.equal(out.verdict, 'ERROR');
  assert.equal(out.confidence, null);
  assert.ok(out.comments.includes('Failed to parse'));
});
