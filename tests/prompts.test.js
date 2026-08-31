import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  generateSystemPrompt,
  generateUserPrompt,
  extractSourceText,
  generateGroupSystemPrompt,
  generateGroupUserPrompt,
  assembleGroupSources,
  PROMPT_VERSION,
  PROMPT_LANGUAGES,
  localizeSystemPrompt,
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

// --- source_quote field contract ---

test('both system prompts specify the source_quote field', () => {
  for (const prompt of [generateSystemPrompt(), generateGroupSystemPrompt()]) {
    assert.ok(prompt.includes('"source_quote"'), 'schema should declare source_quote');
    assert.ok(/copy the passage exactly/i.test(prompt), 'should demand a verbatim copy');
    assert.ok(prompt.includes(' ... '), 'should document the ellipsis joiner');
  }
});

test('every few-shot example in both prompts includes a source_quote key', () => {
  for (const prompt of [generateSystemPrompt(), generateGroupSystemPrompt()]) {
    const examples = prompt.match(/^\{"support_score[^\n]*\}$/gm) || [];
    assert.ok(examples.length >= 3, 'examples should be discoverable');
    for (const example of examples) {
      const parsed = JSON.parse(example);
      assert.ok('source_quote' in parsed, `example missing source_quote: ${example.slice(0, 60)}`);
      assert.equal(typeof parsed.source_quote, 'string');
    }
  }
});

test('few-shot quotes are copied verbatim from their own example source text', () => {
  // The examples teach verbatim copying, so they must themselves be verbatim:
  // a paraphrased quote in an example trains the behaviour we then reject.
  for (const prompt of [generateSystemPrompt(), generateGroupSystemPrompt()]) {
    const blocks = prompt.split('<example>').slice(1).map(b => b.split('</example>')[0]);
    for (const block of blocks) {
      const jsonLine = (block.match(/^\{"support_score[^\n]*\}$/m) || [])[0];
      if (!jsonLine) continue;
      const quote = JSON.parse(jsonLine).source_quote;
      if (!quote) continue;
      const sourceLines = block.split('\n').filter(l => /^Source( \[|\stext:)/.test(l)).join(' ');
      for (const segment of quote.split(' ... ')) {
        assert.ok(
          sourceLines.includes(segment),
          `example quote not verbatim in its source: ${segment.slice(0, 60)}`
        );
      }
    }
  }
});

test('omission and source-unavailable examples carry an empty source_quote', () => {
  const prompt = generateSystemPrompt();
  const examples = (prompt.match(/^\{"support_score[^\n]*\}$/gm) || []).map(e => JSON.parse(e));
  const omission = examples.find(e => e.reason_type === 'omission');
  const unavailable = examples.find(e => e.verdict === 'SOURCE UNAVAILABLE');
  assert.equal(omission.source_quote, '');
  assert.equal(unavailable.source_quote, '');
});

// --- localizeSystemPrompt / PROMPT_LANGUAGES ---
// Pulled out of main.js (2026-08-31) so the batch pipeline can localize
// comments too, not just the interactive userscript — service/verifier.js
// calls this with a single wiki language code passed as both `lang` and
// `articleLangCode`, unlike main.js's caller (main.js has a distinct UI
// language vs. raw article language; see the function's own doc comment).

test('localizeSystemPrompt returns the prompt verbatim for English or unknown language', () => {
  const base = 'SYSTEM PROMPT';
  assert.equal(localizeSystemPrompt(base, { lang: 'en', articleLangCode: 'en' }), base);
  assert.equal(localizeSystemPrompt(base, {}), base);
  assert.equal(localizeSystemPrompt(base), base);
});

test('localizeSystemPrompt names the language for a curated code, from a single langCode param', () => {
  const base = 'SYSTEM PROMPT';
  for (const [code, name] of Object.entries(PROMPT_LANGUAGES)) {
    const out = localizeSystemPrompt(base, { lang: code, articleLangCode: code });
    assert.ok(out.startsWith(base), `${code}: the benchmark-tuned prompt must be left intact`);
    assert.ok(out.includes(name), `${code}: directive does not name the language`);
    assert.ok(out.includes('SOURCE UNAVAILABLE'), `${code}: directive drops the English verdict enum`);
  }
});

test('localizeSystemPrompt falls back to a generic directive for a non-curated, non-English code', () => {
  const base = 'SYSTEM PROMPT';
  const out = localizeSystemPrompt(base, { lang: 'de', articleLangCode: 'de' });
  assert.ok(out.startsWith(base));
  assert.match(out, /same language as the claim/i);
});

test('localizeSystemPrompt keeps source_quote verbatim-in-source-language even when localized', () => {
  const out = localizeSystemPrompt('SYSTEM PROMPT', { lang: 'ru', articleLangCode: 'ru' });
  assert.match(out, /source_quote.*verbatim/i);
});

// citation_findings.prompt_version (ToolsDB) is part of that table's unique
// key specifically so a prompt change invalidates old findings instead of
// silently overwriting them — see PROMPT_VERSION's doc comment. That only
// works if PROMPT_VERSION actually moves when the prompt does; this pins the
// current prompt's hash so an edit to generateSystemPrompt() without a
// matching version bump fails here instead of shipping unnoticed.
//
// On a deliberate prompt change: update PROMPT_VERSION in core/prompts.js,
// then replace EXPECTED_HASH below with the value this test's failure
// message reports.
test('PROMPT_VERSION is bumped whenever the system prompt text changes', () => {
  const EXPECTED_HASH = '0d151a226f7f1e0262e1ded8cb158b1e7876472f8ef858cecef7c611a3870b89';
  const actual = createHash('sha256').update(generateSystemPrompt(), 'utf8').digest('hex');
  assert.equal(
    actual,
    EXPECTED_HASH,
    `generateSystemPrompt() changed (hash now ${actual}) but PROMPT_VERSION is still "${PROMPT_VERSION}". ` +
    `Bump PROMPT_VERSION in core/prompts.js and update EXPECTED_HASH in this test to match.`
  );
});
