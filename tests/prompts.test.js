import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSystemPrompt,
  generateUserPrompt,
  extractSourceText,
  generateGroupSystemPrompt,
  generateGroupUserPrompt,
  assembleGroupSources,
} from '../core/prompts.js';

test('generateSystemPrompt returns a non-empty string', () => {
  const out = generateSystemPrompt();
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 500, 'prompt should be substantial');
});

test('generateSystemPrompt enumerates the four verdict categories', () => {
  const out = generateSystemPrompt();
  for (const verdict of ['SUPPORTED', 'PARTIALLY SUPPORTED', 'NOT SUPPORTED', 'SOURCE UNAVAILABLE']) {
    assert.ok(out.includes(verdict), `missing verdict: ${verdict}`);
  }
});

test('generateUserPrompt embeds claim and source text', () => {
  const claim = 'THE CLAIM TEXT MARKER';
  const source = 'THE SOURCE TEXT MARKER';
  const out = generateUserPrompt(claim, source);
  assert.ok(out.includes(claim));
  assert.ok(out.includes(source));
});

// --- extractSourceText (refactored out of generateUserPrompt; must keep parity) ---

test('extractSourceText unwraps Source Content framing', () => {
  const wrapped = 'Source URL: https://example.com\n\nSource Content:\nThe actual body text.';
  assert.equal(extractSourceText(wrapped), 'The actual body text.');
});

test('extractSourceText unwraps Manual source text framing', () => {
  const wrapped = 'Manual source text:\n   The pasted body.';
  assert.equal(extractSourceText(wrapped), 'The pasted body.');
});

test('extractSourceText returns input unchanged when no framing present', () => {
  const raw = 'Just some plain source text with no headers.';
  assert.equal(extractSourceText(raw), raw);
});

test('generateUserPrompt strips the Source Content framing via extractSourceText', () => {
  const out = generateUserPrompt('A claim', 'Source URL: https://e.com\n\nSource Content:\nBODY');
  // The framing headers must not leak into the prompt; only the body remains.
  assert.ok(out.includes('BODY'));
  assert.ok(!out.includes('Source Content:'));
  assert.ok(!out.includes('Source URL:'));
});

// --- group / collective prompts ---

test('generateGroupSystemPrompt enumerates the four verdicts and stresses collective support', () => {
  const out = generateGroupSystemPrompt();
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 500);
  for (const verdict of ['SUPPORTED', 'PARTIALLY SUPPORTED', 'NOT SUPPORTED', 'SOURCE UNAVAILABLE']) {
    assert.ok(out.includes(verdict), `missing verdict: ${verdict}`);
  }
  assert.match(out, /TOGETHER|COLLECTIVELY/, 'should instruct collective evaluation');
  assert.ok(out.includes('reason_type'), 'should keep reason_type schema');
});

test('generateGroupUserPrompt embeds claim and assembled source text', () => {
  const out = generateGroupUserPrompt('CLAIM_MARKER', 'ASSEMBLED_SOURCES_MARKER');
  assert.ok(out.includes('CLAIM_MARKER'));
  assert.ok(out.includes('ASSEMBLED_SOURCES_MARKER'));
  assert.match(out, /together/i);
});

// --- assembleGroupSources ---

test('assembleGroupSources labels each source and reports availability', () => {
  const { text, anyAvailable } = assembleGroupSources([
    { citationNumbers: ['1'], url: 'https://a.com', content: 'Source Content:\nAlpha body.' },
    { citationNumbers: ['2'], url: 'https://b.com', content: 'Source Content:\nBeta body.' },
  ]);
  assert.equal(anyAvailable, true);
  assert.ok(text.includes('Source [1] (https://a.com):'));
  assert.ok(text.includes('Alpha body.'));
  assert.ok(text.includes('Source [2] (https://b.com):'));
  assert.ok(text.includes('Beta body.'));
});

test('assembleGroupSources marks unfetched sources as unavailable with a reason', () => {
  const { text, anyAvailable } = assembleGroupSources([
    { citationNumbers: ['3'], url: 'https://x.com', content: null, status: 403 },
    { citationNumbers: ['4'], url: 'https://y.com', content: null, error: 'network error' },
  ]);
  assert.equal(anyAvailable, false, 'no usable content present');
  assert.ok(text.includes('could not be retrieved: HTTP 403'));
  assert.ok(text.includes('could not be retrieved: network error'));
});

test('assembleGroupSources flags anyAvailable when at least one source has content', () => {
  const { anyAvailable } = assembleGroupSources([
    { citationNumbers: ['5'], url: 'https://x.com', content: null, status: 404 },
    { citationNumbers: ['6'], url: 'https://y.com', content: 'Source Content:\nUsable.' },
  ]);
  assert.equal(anyAvailable, true);
});

test('assembleGroupSources merges citation numbers for a shared source', () => {
  const { text } = assembleGroupSources([
    { citationNumbers: ['7', '9'], url: 'https://shared.com', content: 'Source Content:\nShared body.' },
  ]);
  assert.ok(text.includes('Source [7][9] (https://shared.com):'));
});

test('assembleGroupSources treats whitespace-only content as unavailable', () => {
  const { anyAvailable, text } = assembleGroupSources([
    { citationNumbers: ['8'], url: 'https://blank.com', content: 'Source Content:\n   \n  ' },
  ]);
  assert.equal(anyAvailable, false);
  assert.ok(text.includes('could not be retrieved'));
});
