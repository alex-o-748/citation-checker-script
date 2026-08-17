import { test } from 'node:test';
import assert from 'node:assert';
import { runVerification, getReportUnits } from '../core/verify-run.js';

test('runVerification yields done event for empty citations', async () => {
  const citations = [];
  const options = {
    fetchSource: () => Promise.resolve({ content: 'test', error: null, status: 200 }),
    verifySingle: () => Promise.resolve({ text: '{}', usage: { input: 0, output: 0 } }),
    verifyGroup: () => Promise.resolve({ text: '{}', usage: { input: 0, output: 0 } }),
    signal: null
  };

  const events = [];
  for await (const event of runVerification(citations, options)) {
    events.push(event);
  }

  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, 'done');
  assert.strictEqual(events[0].completed, 0);
  assert.strictEqual(events[0].total, 0);
  assert.strictEqual(events[0].aborted, false);
});

test('getReportUnits handles empty results', () => {
  const units = getReportUnits([], new Map());
  assert.deepStrictEqual(units, []);
});