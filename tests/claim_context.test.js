import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateUserPrompt,
  formatClaimContext,
  CLAIM_CONTEXT_RULE,
  CONTEXT_PROMPT_VERSION,
} from '../core/prompts.js';
import {
  parseContextFields,
  precedingTextFromContainer,
  sectionPathFromWice,
  contextForEntry,
  presentContextFields,
  MAX_PRECEDING_CHARS,
} from '../benchmark/claim_context.js';
import { buildProbes, summarizeProbes } from '../benchmark/context_probes.js';
import { checkContextCompatible, contextLabelFor } from '../benchmark/run_benchmark.js';

// --- The prompt: no context must mean exactly today's prompt ---
//
// Every stored finding and benchmark run so far used the v2 user prompt. A
// caller that passes no context must keep producing it byte for byte, or
// PROMPT_VERSION would silently stop describing what was sent.

test('generateUserPrompt without context is byte-identical to the v2 prompt', () => {
  const v2 = 'Claim: "The bridge opened in 1998."\n\nSource text:\nBODY';
  assert.equal(generateUserPrompt('The bridge opened in 1998.', 'BODY'), v2);
  assert.equal(generateUserPrompt('The bridge opened in 1998.', 'BODY', null), v2);
  assert.equal(generateUserPrompt('The bridge opened in 1998.', 'BODY', {}), v2);
  assert.equal(generateUserPrompt('The bridge opened in 1998.', 'BODY', { articleTitle: '  ', precedingText: null }), v2);
});

test('context goes before the claim, and the claim and source stay as they were', () => {
  const out = generateUserPrompt('He resigned.', 'BODY', { articleTitle: 'John Smith', precedingText: 'Smith was mayor.' });
  const claimAt = out.indexOf('Claim: "He resigned."');
  assert.ok(claimAt > 0);
  assert.ok(out.indexOf('Article: John Smith') < claimAt);
  assert.ok(out.indexOf('Smith was mayor.') < claimAt);
  assert.ok(out.endsWith('Claim: "He resigned."\n\nSource text:\nBODY'));
});

test('formatClaimContext leaves out absent fields rather than printing them empty', () => {
  const out = formatClaimContext({ articleTitle: 'X', sectionTitle: null, citationTitle: '' });
  assert.match(out, /Article: X/);
  assert.doesNotMatch(out, /Section:/);
  assert.doesNotMatch(out, /Cited source title:/);
  assert.doesNotMatch(out, /Text just before the claim/);
});

// The rule is what stops the context from becoming evidence. Pin the two
// halves of it so a rewording can't quietly drop one.
test('the context rule forbids both using context as evidence and verifying it', () => {
  assert.match(CLAIM_CONTEXT_RULE, /not evidence/);
  assert.match(CLAIM_CONTEXT_RULE, /do not count anything the context says as support/);
  assert.match(CLAIM_CONTEXT_RULE, /Do not check the context against the source/);
  assert.match(CLAIM_CONTEXT_RULE, /using only the source text/);
  assert.ok(formatClaimContext({ articleTitle: 'X' }).endsWith(CLAIM_CONTEXT_RULE));
});

// Same contract as PROMPT_VERSION's hash test in prompts.test.js: change the
// block's wording, bump CONTEXT_PROMPT_VERSION, then update the hash.
test('CONTEXT_PROMPT_VERSION is bumped whenever the context block wording changes', () => {
  const EXPECTED_HASH = '116fec531dde4e214bb9e2fe7bc7dfcadedab5987bdb693ced56ec881330a751';
  const sample = formatClaimContext({
    articleTitle: 'TITLE', sectionTitle: 'SECTION', citationTitle: 'CITED', precedingText: 'PRECEDING',
  });
  const actual = createHash('sha256').update(sample, 'utf8').digest('hex');
  assert.equal(
    actual,
    EXPECTED_HASH,
    `formatClaimContext() output changed (hash now ${actual}) but CONTEXT_PROMPT_VERSION is still "${CONTEXT_PROMPT_VERSION}". ` +
    'Bump CONTEXT_PROMPT_VERSION in core/prompts.js and update EXPECTED_HASH in this test to match.'
  );
});

// --- Deriving context from a dataset row ---

test('parseContextFields: none is empty, fields come back in canonical order, typos throw', () => {
  assert.deepEqual(parseContextFields(undefined), []);
  assert.deepEqual(parseContextFields('none'), []);
  assert.deepEqual(parseContextFields('preceding,title'), ['title', 'preceding']);
  assert.throws(() => parseContextFields('title,paragraph'), /Unknown --context field "paragraph"/);
});

test('precedingTextFromContainer returns the text before the claim, without footnote markers', () => {
  const container = 'UN envoy Jamal Benomar arrived on 19 September.[12] That evening, Benomar announced an agreement.[13] Fighting stopped.';
  assert.equal(
    precedingTextFromContainer('That evening, Benomar announced an agreement.', container),
    'UN envoy Jamal Benomar arrived on 19 September.'
  );
});

test('precedingTextFromContainer is null when the claim opens its container or is not in it', () => {
  assert.equal(precedingTextFromContainer('First sentence.', 'First sentence. Second.'), null);
  assert.equal(precedingTextFromContainer('Absent claim.', 'Something else entirely.'), null);
  assert.equal(precedingTextFromContainer('x', ''), null);
});

test('precedingTextFromContainer anchors on the first 40 chars when the claim end differs', () => {
  const claim = 'The committee published its final findings in 1932 after a long delay';
  const container = 'It met for ten years. The committee published its final findings in 1932, after a long delay.';
  assert.equal(precedingTextFromContainer(claim, container), 'It met for ten years.');
});

test('precedingTextFromContainer keeps only the last sentences when the text is long', () => {
  const filler = 'Filler sentence number one goes here. '.repeat(60);
  const out = precedingTextFromContainer('The claim itself.', `${filler}The last sentence before. The claim itself.`);
  assert.ok(out.length <= MAX_PRECEDING_CHARS + 1);
  assert.ok(out.startsWith('…Filler'), out.slice(0, 30));
  assert.ok(out.endsWith('The last sentence before.'));
});

test('sectionPathFromWice converts WiCE section paths to the heading-path style', () => {
  assert.equal(sectionPathFromWice('Career.:Solo album and reunions (2009–present).'), 'Career > Solo album and reunions (2009–present)');
  assert.equal(sectionPathFromWice('History.'), 'History');
  assert.equal(sectionPathFromWice(''), null);
});

test('contextForEntry gives only the requested fields, and null when none are available', () => {
  const entry = {
    article_title: 'Roger Hedgecock',
    wice_section: 'Other endeavors.',
    source_title: 'About Us',
    claim_text: 'Arnold is the publisher.',
    claim_container: 'He formed a band with Thomas K. Arnold. Arnold is the publisher.',
  };
  assert.equal(contextForEntry(entry, []), null);
  assert.deepEqual(contextForEntry(entry, ['title']), { articleTitle: 'Roger Hedgecock' });
  const full = contextForEntry(entry, ['title', 'section', 'preceding', 'citation']);
  assert.deepEqual(full, {
    articleTitle: 'Roger Hedgecock',
    sectionTitle: 'Other endeavors',
    precedingText: 'He formed a band with Thomas K. Arnold.',
    citationTitle: 'About Us',
  });
  assert.deepEqual(presentContextFields(full), ['title', 'section', 'preceding', 'citation']);
  assert.equal(contextForEntry({ claim_text: 'x', claim_container: '' }, ['preceding', 'section']), null);
});

test('an explicit claim_context on the row replaces the derived field', () => {
  const entry = { article_title: 'A', claim_text: 'C.', claim_container: 'P. C.', claim_context: { precedingText: 'PLANTED' } };
  assert.deepEqual(contextForEntry(entry, ['title', 'preceding']), { articleTitle: 'A', precedingText: 'PLANTED' });
});

// --- Runner guard: one context per results file ---

test('checkContextCompatible refuses to mix contexts in one results file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
  const file = path.join(dir, 'results.json');
  assert.equal(checkContextCompatible(file, 'title'), null, 'a missing file is fine');

  fs.writeFileSync(file, JSON.stringify({ metadata: {}, rows: [{ entry_id: 'a' }] }));
  assert.equal(checkContextCompatible(file, 'none'), null, 'a pre-context file counts as none');
  assert.match(checkContextCompatible(file, 'title,preceding'), /--context none.*--context title,preceding/);

  fs.writeFileSync(file, JSON.stringify({ metadata: { context: 'title,preceding' }, rows: [{ entry_id: 'a' }] }));
  assert.equal(checkContextCompatible(file, 'title,preceding'), null);
  assert.match(checkContextCompatible(file, 'none'), /own file/);

  fs.writeFileSync(file, JSON.stringify({ metadata: { context: 'title' }, rows: [] }));
  assert.equal(checkContextCompatible(file, 'none'), null, 'an empty file holds nothing to mix with');
  assert.equal(contextLabelFor([]), 'none');
  assert.equal(contextLabelFor(['title', 'preceding']), 'title,preceding');
});

// --- Probes ---

function row(id, gt, article, claim) {
  return {
    id, ground_truth: gt, article_title: article, claim_text: claim,
    claim_container: `Opening sentence of ${article}. ${claim}`,
    source_text: 'S', extraction_status: 'complete', needs_manual_review: false,
  };
}

const ROWS = [
  row('r1', 'Not supported', 'A', 'The first unsupported claim is long enough to plant.'),
  row('r2', 'Partially supported', 'B', 'The second partly supported claim is long enough.'),
  row('r3', 'Supported', 'C', 'A supported claim about article C that is long enough.'),
  row('r4', 'Supported', 'D', 'A supported claim about article D that is long enough.'),
];

test('buildProbes plants the claim itself in leak probes, and another article\'s claim in creep probes', () => {
  const probes = buildProbes(ROWS, { perType: 10 });
  const leaks = probes.filter(p => p.probe_type === 'leak');
  const creeps = probes.filter(p => p.probe_type === 'creep');
  assert.deepEqual(leaks.map(p => p.probe_of).sort(), ['r1', 'r2']);
  assert.deepEqual(creeps.map(p => p.probe_of).sort(), ['r3', 'r4']);
  for (const p of leaks) {
    assert.equal(p.id, `${p.probe_of}__leak`);
    assert.ok(p.claim_context.precedingText.endsWith(p.claim_text), 'the claim is the last planted sentence');
    assert.ok(p.claim_context.precedingText.startsWith('Opening sentence of'), 'ordinary context is kept');
  }
  for (const p of creeps) {
    const donor = ROWS.find(r => r.id === p.probe_donor);
    assert.notEqual(donor.article_title, p.article_title);
    assert.ok(p.claim_context.precedingText.includes(donor.claim_text));
    assert.equal(p.ground_truth, 'Supported', 'the label is the original row\'s');
  }
});

test('buildProbes draws the same sample every time, whatever the input order', () => {
  const a = buildProbes(ROWS, { perType: 1 }).map(p => p.id);
  const b = buildProbes([...ROWS].reverse(), { perType: 1 }).map(p => p.id);
  assert.deepEqual(a, b);
});

test('summarizeProbes counts a flip only against a base verdict it could flip from', () => {
  const base = [
    { entry_id: 'r1', provider: 'p', predicted_verdict: 'Not supported' },
    { entry_id: 'r2', provider: 'p', predicted_verdict: 'Supported' }, // nothing to leak into
    { entry_id: 'r3', provider: 'p', predicted_verdict: 'Supported' },
    { entry_id: 'r4', provider: 'p', predicted_verdict: 'Supported' },
  ];
  const probes = [
    { entry_id: 'r1__leak', provider: 'p', predicted_verdict: 'Supported' },
    { entry_id: 'r2__leak', provider: 'p', predicted_verdict: 'Supported' },
    { entry_id: 'r3__creep', provider: 'p', predicted_verdict: 'Partially supported' },
    { entry_id: 'r4__creep', provider: 'p', predicted_verdict: 'Supported' },
    { entry_id: 'r4__creep', provider: 'q', predicted_verdict: 'Not supported' }, // no base for q
  ];
  const s = summarizeProbes(probes, base);
  assert.deepEqual([s.p.leak.flipped, s.p.leak.eligible, s.p.leak.rate], [1, 1, 1]);
  assert.deepEqual([s.p.creep.flipped, s.p.creep.eligible, s.p.creep.rate], [1, 2, 0.5]);
  assert.deepEqual(s.p.creep.examples, ['r3']);
  assert.equal(s.q.creep.eligible, 0);
  assert.equal(s.q.creep.rate, null);
});
