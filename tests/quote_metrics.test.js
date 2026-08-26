import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateMetrics } from '../benchmark/analyze_results.js';

// Minimal result rows: calculateMetrics only reads the fields asserted here
// plus verdict/ground_truth, which every row needs to count as valid.
function row(overrides) {
  return {
    predicted_verdict: 'Supported',
    ground_truth: 'Supported',
    support_score: 90,
    latency_ms: 100,
    error: null,
    source_quote: '',
    quote_verified: false,
    ...overrides,
  };
}

test('quote metrics count only verdicts that should carry a quote', () => {
  const m = calculateMetrics([
    row({ predicted_verdict: 'Supported', source_quote: 'a passage', quote_verified: true }),
    row({ predicted_verdict: 'Partially supported', ground_truth: 'Partially supported', source_quote: 'b passage', quote_verified: true }),
    // Omission: nothing to quote, so it must not count against the offer rate.
    row({ predicted_verdict: 'Not supported', ground_truth: 'Not supported', reason_type: 'omission' }),
    // Source unavailable: likewise excluded.
    row({ predicted_verdict: 'Source unavailable', ground_truth: 'Source unavailable' }),
  ]);

  assert.equal(m.quotes.eligible, 2);
  assert.equal(m.quotes.offered, 2);
  assert.equal(m.quotes.verified, 2);
  assert.equal(m.quotes.offerRate, 1);
  assert.equal(m.quotes.fidelity, 1);
});

test('a contradiction verdict is eligible for a quote', () => {
  const m = calculateMetrics([
    row({ predicted_verdict: 'Not supported', ground_truth: 'Not supported', reason_type: 'contradiction' }),
  ]);
  assert.equal(m.quotes.eligible, 1);
  assert.equal(m.quotes.offered, 0);
  assert.equal(m.quotes.offerRate, 0);
});

test('fidelity separates quotes that were offered from quotes that checked out', () => {
  const m = calculateMetrics([
    row({ source_quote: 'found in source', quote_verified: true }),
    row({ source_quote: 'invented passage', quote_verified: false }),
    row({ source_quote: '', quote_verified: false }),
  ]);

  assert.equal(m.quotes.eligible, 3);
  assert.equal(m.quotes.offered, 2);
  assert.equal(m.quotes.verified, 1);
  assert.equal(m.quotes.fidelity, 0.5);
});

test('quote metrics are zero, not NaN, on legacy results with no quote fields', () => {
  const m = calculateMetrics([
    { predicted_verdict: 'Supported', ground_truth: 'Supported', support_score: 90, latency_ms: 10, error: null },
  ]);
  assert.equal(m.quotes.offered, 0);
  assert.equal(m.quotes.offerRate, 0);
  assert.equal(m.quotes.fidelity, 0);
});

// --- accuracy split by quote status -------------------------------------
//
// The evidence for whether an unverifiable quote should warn the editor. The
// UI currently says nothing, on the grounds that no gap has been measured.

test('accuracy is reported separately for verified and unverified quotes', () => {
  const m = calculateMetrics([
    // Quote checked out, verdict right.
    row({ source_quote: 'q', quote_verified: true, predicted_verdict: 'Supported', ground_truth: 'Supported' }),
    row({ source_quote: 'q', quote_verified: true, predicted_verdict: 'Supported', ground_truth: 'Supported' }),
    // Quote did not check out, verdict still right.
    row({ source_quote: 'q', quote_verified: false, predicted_verdict: 'Supported', ground_truth: 'Supported' }),
    // Quote did not check out, verdict wrong.
    row({ source_quote: 'q', quote_verified: false, predicted_verdict: 'Supported', ground_truth: 'Not supported' }),
  ]);

  assert.equal(m.quotes.accuracyWhenQuoteVerified, 1);
  assert.equal(m.quotes.accuracyWhenQuoteUnverified, 0.5);
  assert.equal(m.quotes.verifiedRows, 2);
  assert.equal(m.quotes.unverifiedRows, 2);
  assert.equal(m.quotes.gap, 0.5);
});

test('a zero gap is reported as zero, not as missing data', () => {
  // The outcome that keeps the warning out of the UI.
  const m = calculateMetrics([
    row({ source_quote: 'q', quote_verified: true, ground_truth: 'Supported' }),
    row({ source_quote: 'q', quote_verified: false, ground_truth: 'Supported' }),
  ]);
  assert.equal(m.quotes.gap, 0);
});

test('the split degrades to zero rather than NaN when one side is empty', () => {
  const m = calculateMetrics([
    row({ source_quote: 'q', quote_verified: true, ground_truth: 'Supported' }),
  ]);
  assert.equal(m.quotes.unverifiedRows, 0);
  assert.equal(m.quotes.accuracyWhenQuoteUnverified, 0);
  assert.ok(Number.isFinite(m.quotes.gap));
});
