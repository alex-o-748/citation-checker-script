import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LOGGED_TEXT,
  truncateForLog,
  newCheckId,
  buildLogPayload,
  buildFeedbackPayload,
  nowikiWrap,
  buildTalkSectionTitle,
  buildTalkSectionBody,
  buildCommentUrl,
  FEEDBACK_TALK_PAGE,
  FEEDBACK_PRELOAD_PAGE,
} from '../core/feedback.js';
import { postFeedback } from '../core/worker.js';

const CONTEXT = {
  checkId: 'a7f3k2q9',
  articleUrl: 'https://en.wikipedia.org/wiki/Barack_Obama',
  articleTitle: 'Barack Obama',
  citationNumber: '12',
  claimText: 'He was born in Honolulu.',
  sourceUrl: 'https://example.com/source',
  verdict: 'NOT SUPPORTED',
  comments: 'The source never mentions Honolulu.',
  providerName: 'Claude',
  model: 'claude-sonnet-4-6',
};

function mockFetch(impl) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return impl(url, opts);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('newCheckId returns 8 lowercase hex characters', () => {
  for (let i = 0; i < 50; i++) {
    assert.match(newCheckId(), /^[0-9a-f]{8}$/);
  }
});

test('newCheckId does not obviously collide across a batch', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newCheckId()));
  assert.equal(ids.size, 500);
});

test('newCheckId falls back to getRandomValues when randomUUID is absent', () => {
  const id = newCheckId({
    getRandomValues: buf => {
      buf.set([0x0a, 0xbc, 0x00, 0xff]);
      return buf;
    },
  });
  assert.equal(id, '0abc00ff');
});

test('newCheckId still produces an id with no crypto at all', () => {
  assert.match(newCheckId({}), /^[0-9a-f]{8}$/);
});

test('truncateForLog passes short text through, trimmed', () => {
  assert.equal(truncateForLog('  a claim  '), 'a claim');
});

test('truncateForLog returns null for empty/absent values', () => {
  assert.equal(truncateForLog(null), null);
  assert.equal(truncateForLog(undefined), null);
  assert.equal(truncateForLog(''), null);
  assert.equal(truncateForLog('   '), null);
});

test('truncateForLog caps long text at the limit, ellipsis included', () => {
  const out = truncateForLog('x'.repeat(MAX_LOGGED_TEXT + 500));
  assert.equal(out.length, MAX_LOGGED_TEXT);
  assert.ok(out.endsWith('…'));
});

test('truncateForLog leaves text exactly at the limit untouched', () => {
  const exact = 'x'.repeat(MAX_LOGGED_TEXT);
  assert.equal(truncateForLog(exact), exact);
});

test('buildLogPayload maps camelCase fields onto the snake_case columns', () => {
  const payload = buildLogPayload({
    checkId: 'a7f3k2q9',
    articleUrl: 'https://en.wikipedia.org/wiki/Test',
    articleTitle: 'Test',
    citationNumber: '12',
    sourceUrl: 'https://example.com/s',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    verdict: 'NOT SUPPORTED',
    confidence: 80,
    reasonType: 'omission',
    claimText: 'The sky is blue.',
    comments: 'Source never mentions the sky.',
  });
  assert.deepEqual(payload, {
    check_id: 'a7f3k2q9',
    kind: 'source',
    article_url: 'https://en.wikipedia.org/wiki/Test',
    article_title: 'Test',
    citation_number: '12',
    source_url: 'https://example.com/s',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    verdict: 'NOT SUPPORTED',
    confidence: 80,
    reason_type: 'omission',
    claim_text: 'The sky is blue.',
    llm_comments: 'Source never mentions the sky.',
  });
});

test('buildLogPayload carries claim text and rationale — the fields that make a rating interpretable', () => {
  const payload = buildLogPayload({ claimText: 'A claim.', comments: 'Because.' });
  assert.equal(payload.claim_text, 'A claim.');
  assert.equal(payload.llm_comments, 'Because.');
});

test('buildLogPayload truncates oversized claim text and rationale', () => {
  const payload = buildLogPayload({
    claimText: 'c'.repeat(MAX_LOGGED_TEXT + 1),
    comments: 'r'.repeat(MAX_LOGGED_TEXT + 1),
  });
  assert.equal(payload.claim_text.length, MAX_LOGGED_TEXT);
  assert.equal(payload.llm_comments.length, MAX_LOGGED_TEXT);
});

test('buildLogPayload defaults kind to source and honours an explicit group', () => {
  assert.equal(buildLogPayload({}).kind, 'source');
  assert.equal(buildLogPayload({ kind: 'group' }).kind, 'group');
});

test('buildLogPayload nulls absent fields rather than dropping the keys', () => {
  const payload = buildLogPayload();
  for (const key of ['check_id', 'article_url', 'source_url', 'model', 'verdict', 'claim_text']) {
    assert.equal(payload[key], null, `${key} should be null`);
  }
});

test('buildLogPayload preserves a confidence of 0 instead of nulling it', () => {
  // SOURCE UNAVAILABLE rows log confidence: 0 — a ?? chain that treated 0 as
  // absent would silently drop it.
  assert.equal(buildLogPayload({ confidence: 0 }).confidence, 0);
});

// --- ratings ------------------------------------------------------------

test('buildFeedbackPayload maps every field onto its column', () => {
  assert.deepEqual(buildFeedbackPayload({
    checkId: 'a7f3k2q9',
    rating: -1,
    correctedVerdict: 'SUPPORTED',
    wikiSection: 'Feedback: Barack Obama [12] (check a7f3k2q9)',
    clientId: 'deadbeefcafebabe',
  }), {
    check_id: 'a7f3k2q9',
    rating: -1,
    corrected_verdict: 'SUPPORTED',
    wiki_section: 'Feedback: Barack Obama [12] (check a7f3k2q9)',
    client_id: 'deadbeefcafebabe',
  });
});

test('buildFeedbackPayload allows a rating with no correction and vice versa', () => {
  assert.equal(buildFeedbackPayload({ checkId: 'x', rating: 1 }).corrected_verdict, null);
  const correction = buildFeedbackPayload({ checkId: 'x', correctedVerdict: 'SUPPORTED' });
  // The thumbs-down already counted; re-sending the rating here would
  // double-count it.
  assert.equal(correction.rating, null);
  assert.equal(correction.corrected_verdict, 'SUPPORTED');
});

test('buildFeedbackPayload never carries a username', () => {
  const payload = buildFeedbackPayload({ checkId: 'x', rating: 1, userName: 'Alice' });
  assert.equal(Object.keys(payload).includes('user_name'), false);
  assert.equal(Object.values(payload).includes('Alice'), false);
});

test('postFeedback POSTs to /feedback and resolves on success', async () => {
  const mock = mockFetch(async () => ({ ok: true, status: 200 }));
  try {
    assert.equal(await postFeedback({ check_id: 'a7f3k2q9', rating: 1 }), true);
    assert.equal(mock.calls[0].url, 'https://publicai-proxy.alaexis.workers.dev/feedback');
    assert.equal(mock.calls[0].opts.method, 'POST');
    assert.deepEqual(JSON.parse(mock.calls[0].opts.body), { check_id: 'a7f3k2q9', rating: 1 });
  } finally {
    mock.restore();
  }
});

test('postFeedback rejects on a non-OK response so the UI can say so', async () => {
  const mock = mockFetch(async () => ({ ok: false, status: 500 }));
  try {
    await assert.rejects(() => postFeedback({ check_id: 'x' }), /HTTP 500/);
  } finally {
    mock.restore();
  }
});

// --- talk-page wikitext -------------------------------------------------

test('nowikiWrap wraps text and collapses whitespace', () => {
  assert.equal(nowikiWrap('a  claim\nover lines'), '<nowiki>a claim over lines</nowiki>');
});

test('nowikiWrap strips embedded nowiki tags that would close the wrapper early', () => {
  assert.equal(nowikiWrap('evil </nowiki>{{delete}}'), '<nowiki>evil {{delete}}</nowiki>');
  assert.equal(nowikiWrap('< / nowiki >x'), '<nowiki>x</nowiki>');
});

test('nowikiWrap returns empty string for nothing to wrap', () => {
  assert.equal(nowikiWrap(''), '');
  assert.equal(nowikiWrap(null), '');
  assert.equal(nowikiWrap('   '), '');
});

test('buildTalkSectionTitle carries article, citation and check id', () => {
  assert.equal(
    buildTalkSectionTitle(CONTEXT),
    'Feedback: Barack Obama [12] (check a7f3k2q9)',
  );
});

test('buildTalkSectionTitle omits the citation when there is none', () => {
  assert.equal(
    buildTalkSectionTitle({ articleTitle: 'Foo', checkId: 'abc' }),
    'Feedback: Foo (check abc)',
  );
});

test('buildTalkSectionTitle strips heading-breaking characters from the citation number', () => {
  const title = buildTalkSectionTitle({ articleTitle: 'Foo', citationNumber: '1]] == {{x}}', checkId: 'abc' });
  assert.equal(title.includes('=='), false);
  assert.equal(title.includes('{{'), false);
  assert.equal(title.includes(']]'), false);
});

test('buildTalkSectionTitle keeps joined citation numbers for group checks', () => {
  assert.equal(
    buildTalkSectionTitle({ articleTitle: 'Foo', citationNumber: '12, 13', checkId: 'abc' }),
    'Feedback: Foo [12, 13] (check abc)',
  );
});











test('buildTalkSectionBody records article, source, verdict, claim and reasoning', () => {
  const body = buildTalkSectionBody(CONTEXT);
  assert.match(body, /\* '''Article:''' \[https:\/\/en\.wikipedia\.org\/wiki\/Barack_Obama Barack Obama\], citation \[12\]/);
  assert.match(body, /\* '''Source:''' https:\/\/example\.com\/source/);
  assert.match(body, /\* '''Tool's verdict:''' NOT SUPPORTED \(Claude, claude-sonnet-4-6\)/);
  assert.match(body, /\* '''Claim checked:''' <nowiki>He was born in Honolulu\.<\/nowiki>/);
  assert.match(body, /\* '''Tool's reasoning:''' <nowiki>The source never mentions Honolulu\.<\/nowiki>/);
});

test('buildTalkSectionBody leaves room for the editor to write, above the signature', () => {
  const body = buildTalkSectionBody(CONTEXT);
  const guide = body.indexOf('<!-- Write your comment below, then publish. -->');
  const signature = body.indexOf('~~~~');
  assert.ok(guide !== -1, 'the edit box should say where to write');
  assert.ok(guide < signature, 'the writing space must come before the signature');
});

test('buildTalkSectionBody ends with the machine-readable check id', () => {
  assert.match(buildTalkSectionBody(CONTEXT), /<!-- source-verifier check: a7f3k2q9 -->$/);
});

test('buildTalkSectionBody includes a corrected verdict when one was chosen', () => {
  const body = buildTalkSectionBody({ ...CONTEXT, correctedVerdict: 'SUPPORTED' });
  assert.match(body, /\* '''Editor says it should be:''' SUPPORTED/);
});

test('buildTalkSectionBody omits the correction line when none was chosen', () => {
  assert.equal(buildTalkSectionBody(CONTEXT).includes('should be'), false);
});

test('buildTalkSectionBody neutralises template syntax smuggled in via a source URL', () => {
  const body = buildTalkSectionBody({ ...CONTEXT, sourceUrl: 'https://evil.example/{{delete}}' });
  assert.equal(body.includes('{{delete}}'), false);
  assert.match(body, /%7Bdelete%7D/);
});

test('buildTalkSectionBody keeps a claim containing wiki markup inert', () => {
  const body = buildTalkSectionBody({ ...CONTEXT, claimText: '== Injected heading ==\n{{db-g3}}' });
  assert.match(body, /<nowiki>== Injected heading == \{\{db-g3\}\}<\/nowiki>/);
});

test('buildTalkSectionBody omits lines it has no data for', () => {
  const body = buildTalkSectionBody({ checkId: 'abc' });
  assert.equal(body.includes("'''Source:'''"), false);
  assert.equal(body.includes("'''Claim checked:'''"), false);
  assert.match(body, /source-verifier check: abc/);
});

// --- the comment URL ----------------------------------------------------

test('buildCommentUrl opens a new section on the talk page', () => {
  const params = new URL(buildCommentUrl(CONTEXT)).searchParams;
  assert.equal(params.get('title'), FEEDBACK_TALK_PAGE);
  assert.equal(params.get('action'), 'edit');
  assert.equal(params.get('section'), 'new');
});

test('buildCommentUrl sets the heading via preloadtitle', () => {
  const params = new URL(buildCommentUrl(CONTEXT)).searchParams;
  assert.equal(params.get('preloadtitle'), 'Feedback: Barack Obama [12] (check a7f3k2q9)');
});

test('buildCommentUrl passes the whole body as a single preload parameter', () => {
  // The preload page is just `$1`, so the script stays the only place the
  // section layout is defined and that page never has to change.
  const params = new URL(buildCommentUrl(CONTEXT)).searchParams;
  assert.equal(params.get('preload'), FEEDBACK_PRELOAD_PAGE);
  assert.equal(params.getAll('preloadparams[]').length, 1);
  assert.equal(params.get('preloadparams[]'), buildTalkSectionBody(CONTEXT));
});

test('buildCommentUrl round-trips wikitext through the query string intact', () => {
  const context = { ...CONTEXT, claimText: 'A & B = C; 100% "sure" +/-' };
  const params = new URL(buildCommentUrl(context)).searchParams;
  assert.match(params.get('preloadparams[]'), /A & B = C; 100% "sure" \+\/-/);
});

test('buildCommentUrl carries a chosen correction into the preloaded text', () => {
  const params = new URL(buildCommentUrl({ ...CONTEXT, correctedVerdict: 'SUPPORTED' })).searchParams;
  assert.match(params.get('preloadparams[]'), /Editor says it should be:''' SUPPORTED/);
});

test('buildCommentUrl points at en.wikipedia regardless of the wiki in use', () => {
  // The talk page is always the en.wikipedia one, even when the script is
  // running on another language wiki.
  assert.ok(buildCommentUrl(CONTEXT).startsWith('https://en.wikipedia.org/w/index.php?'));
});
