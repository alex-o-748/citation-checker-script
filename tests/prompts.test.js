import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSystemPrompt, generateUserPrompt } from '../core/prompts.js';

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

test('generateUserPrompt without context is byte-identical to omitting it', () => {
  const claim = 'the Premier League';
  const source = 'THE SOURCE TEXT MARKER';
  // undefined, null, and an all-empty context object must all reproduce the
  // original prompt exactly so context is a zero-risk opt-in.
  const base = generateUserPrompt(claim, source);
  assert.equal(generateUserPrompt(claim, source, undefined), base);
  assert.equal(generateUserPrompt(claim, source, null), base);
  assert.equal(generateUserPrompt(claim, source, { articleTitle: '', sectionTitle: '', paragraph: '' }), base);
});

test('generateUserPrompt renders context block above the claim in order', () => {
  const out = generateUserPrompt('the Premier League', 'SRC', {
    articleTitle: 'Raúl Jiménez',
    sectionTitle: 'Club career › Wolverhampton Wanderers',
    paragraph: 'Jiménez won both Serie A and the Premier League.',
  });
  assert.ok(out.includes('Article: Raúl Jiménez'));
  assert.ok(out.includes('Section: Club career › Wolverhampton Wanderers'));
  assert.ok(out.includes('disambiguation only'));
  assert.ok(out.includes('Jiménez won both Serie A and the Premier League.'));
  // Context precedes the Claim, which precedes the Source text.
  assert.ok(out.indexOf('Article:') < out.indexOf('Claim:'));
  assert.ok(out.indexOf('Claim:') < out.indexOf('Source text:'));
});

test('generateUserPrompt emits only the context fields that are present', () => {
  const out = generateUserPrompt('a claim', 'SRC', { paragraph: 'Surrounding sentence.' });
  assert.ok(out.includes('Surrounding sentence.'));
  assert.ok(!out.includes('Article:'));
  assert.ok(!out.includes('Section:'));
});

test('generateUserPrompt ignores context for a standalone claim (parity gate)', () => {
  // A claim with its own explicit subject does not need disambiguation, so the
  // context must be dropped and the prompt left byte-identical to no-context —
  // this is what keeps the feature at parity on claims it cannot help.
  const claim = 'Al Jazeera launched on 1 November 1996.';
  const source = 'SRC';
  const full = { articleTitle: 'Al Jazeera', sectionTitle: 'History', paragraph: 'Al Jazeera launched on 1 November 1996 in Doha.' };
  assert.equal(generateUserPrompt(claim, source, full), generateUserPrompt(claim, source));
  assert.ok(!generateUserPrompt(claim, source, full).includes('Article:'));
});

test('generateUserPrompt attaches context for a dependent-fragment claim', () => {
  // Pronoun-led claim needs its antecedent → context is attached.
  const out = generateUserPrompt('She received the Nobel Prize in 2015.', 'SRC', {
    articleTitle: 'Ada Yonath', paragraph: 'Ada Yonath is a chemist. She received the Nobel Prize in 2015.',
  });
  assert.ok(out.includes('Article: Ada Yonath'));
  assert.ok(out.includes('disambiguation only'));
});
