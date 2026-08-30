import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LOGGED_TEXT,
  truncateForLog,
  newCheckId,
  buildLogPayload,
  buildFeedbackPayload,
  nowikiWrap,
  normalizeRevisionId,
  buildTalkSectionTitle,
  buildTalkSectionBody,
  buildCommentUrl,
  FEEDBACK_TALK_PAGE,
  FEEDBACK_PRELOAD_PAGE,
  CHECK_DETAILS_TITLE,
  EDITOR_EXPLANATION_LABEL,
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
    revisionId: 1234567,
    citationNumber: '12',
    sourceUrl: 'https://example.com/s',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    verdict: 'NOT SUPPORTED',
    supportScore: 80,
    reasonType: 'omission',
    claimText: 'The sky is blue.',
    comments: 'Source never mentions the sky.',
  });
  assert.deepEqual(payload, {
    check_id: 'a7f3k2q9',
    kind: 'source',
    article_url: 'https://en.wikipedia.org/wiki/Test',
    article_title: 'Test',
    revision_id: 1234567,
    citation_number: '12',
    source_url: 'https://example.com/s',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    verdict: 'NOT SUPPORTED',
    confidence: 80,
    reason_type: 'omission',
    claim_text: 'The sky is blue.',
    llm_comments: 'Source never mentions the sky.',
    source_quote: null,
    quote_status: null,
  });
});

test('buildLogPayload carries the source quote and its verification status', () => {
  const payload = buildLogPayload({
    checkId: 'a7f3k2q9',
    verdict: 'SUPPORTED',
    sourceQuote: 'Acme Corp was established in 1985.',
    quoteStatus: 'exact',
  });
  assert.equal(payload.source_quote, 'Acme Corp was established in 1985.');
  assert.equal(payload.quote_status, 'exact');
});

test('buildLogPayload logs an unverified quote rather than dropping it', () => {
  // The UI hides these; the log keeps them, because a quote that was not
  // found in the source is exactly the row worth inspecting later.
  const payload = buildLogPayload({
    sourceQuote: 'a passage the source never contained',
    quoteStatus: 'not-found',
  });
  assert.equal(payload.source_quote, 'a passage the source never contained');
  assert.equal(payload.quote_status, 'not-found');
});

test('buildLogPayload truncates an over-long quote like the other free text', () => {
  const payload = buildLogPayload({ sourceQuote: 'q'.repeat(MAX_LOGGED_TEXT + 500) });
  assert.equal(payload.source_quote.length, MAX_LOGGED_TEXT);
  assert.ok(payload.source_quote.endsWith('…'));
});

test('normalizeRevisionId accepts a revision id as a number or a string', () => {
  assert.equal(normalizeRevisionId(1234567), 1234567);
  assert.equal(normalizeRevisionId('1234567'), 1234567);
  assert.equal(normalizeRevisionId(' 1234567 '), 1234567);
});

// wgRevisionId is 0 on a page with no revision — a preview, a special page.
// That is not a revision and must not be logged as one.
test('normalizeRevisionId rejects anything that is not a positive integer', () => {
  for (const bad of [0, '0', -1, '-1', 1.5, '1.5', '', '  ', null, undefined, NaN,
                     'abc', '12 34', '1e6', '{{delete}}', Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(normalizeRevisionId(bad), null, `accepted ${JSON.stringify(String(bad))}`);
  }
});

test('buildLogPayload records the revision so a logged verdict stays reproducible', () => {
  assert.equal(buildLogPayload({ revisionId: '1234567' }).revision_id, 1234567);
  assert.equal(buildLogPayload({}).revision_id, null);
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

test('buildLogPayload preserves a support score of 0 instead of nulling it', () => {
  // SOURCE UNAVAILABLE rows log support_score: 0 — a ?? chain that treated 0
  // as absent would silently drop it.
  assert.equal(buildLogPayload({ supportScore: 0 }).confidence, 0);
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

// The revision is what makes a report reproducible: the plain article link
// points at whatever the page says today, so without it a reader arriving at
// the section later cannot tell whether they are looking at the text the tool
// read, and two model versions cannot be compared on a fixed page.
test('buildTalkSectionBody names the revision the check ran against', () => {
  const body = buildTalkSectionBody({
    ...CONTEXT,
    revisionId: 1234567,
    revisionUrl: 'https://en.wikipedia.org/w/index.php?title=Barack_Obama&oldid=1234567',
  });
  assert.match(
    body,
    /\* '''Article:''' \[https:\/\/en\.wikipedia\.org\/wiki\/Barack_Obama Barack Obama\], citation \[12\], revision \[https:\/\/en\.wikipedia\.org\/w\/index\.php\?title=Barack_Obama&oldid=1234567 1234567\]/,
  );
});

test('buildTalkSectionBody keeps the revision inside the collapsed tool box', () => {
  const body = buildTalkSectionBody({ ...CONTEXT, revisionId: 1234567 });
  const boxed = body.slice(body.indexOf('{{hidden begin'), body.indexOf('{{hidden end}}'));
  assert.ok(boxed.includes('revision 1234567'));
});

test('buildTalkSectionBody falls back to a bare revision number without a permalink', () => {
  const body = buildTalkSectionBody({ ...CONTEXT, revisionId: 1234567 });
  assert.match(body, /, citation \[12\], revision 1234567$/m);
});

test('buildTalkSectionBody omits the revision when none is known', () => {
  const body = buildTalkSectionBody(CONTEXT);
  assert.equal(body.includes('revision'), false);
});

// The revision reaches the wikitext as a number, so a caller passing something
// else must not be able to open a link or a template through it.
test('buildTalkSectionBody ignores a revision id that is not a plain number', () => {
  for (const bad of ['{{delete}}', '12 34', '1234567e0', '-5', '', 'null']) {
    const body = buildTalkSectionBody({ ...CONTEXT, revisionId: bad });
    assert.equal(body.includes('revision'), false, `leaked ${JSON.stringify(bad)}`);
  }
});

test('buildTalkSectionBody tells the editor where to write and to sign', () => {
  const body = buildTalkSectionBody(CONTEXT);
  assert.match(body, /<!-- Write your explanation here, then sign and publish\. -->/);
});

// Four tildes are an instruction to MediaWiki's pre-save transform, which runs
// over the whole page on every save — a preloaded signature belongs to whoever
// saves next, not to the editor who opened the form, and if it survives that
// save unexpanded it gets some later account's name stamped in. The HTML
// comments are covered too: the transform does not skip them.
test('buildTalkSectionBody never emits a signature, anywhere', () => {
  for (const fields of [CONTEXT, { ...CONTEXT, correctedVerdict: 'SUPPORTED' }, { checkId: 'x' }, {}]) {
    assert.equal(buildTalkSectionBody(fields).includes('~~~'), false);
  }
});

test('buildCommentUrl never carries a signature into the preload', () => {
  const preloaded = new URL(buildCommentUrl(CONTEXT)).searchParams.get('preloadparams[]');
  assert.equal(preloaded.includes('~~~'), false);
});

test('buildTalkSectionBody collapses the tool output behind a hidden box', () => {
  const body = buildTalkSectionBody(CONTEXT);
  const open = body.indexOf(`{{hidden begin|title=${CHECK_DETAILS_TITLE}}}`);
  const close = body.indexOf('{{hidden end}}');
  assert.ok(open !== -1, 'the tool output needs an opening collapse tag');
  assert.ok(close > open, 'the collapse box must be closed after it is opened');
  assert.equal(body.split('{{hidden end}}').length - 1, 1, 'exactly one closing tag');

  for (const line of ["* '''Article:'''", "* '''Source:'''", "* '''Tool's verdict:'''",
                      "* '''Claim checked:'''", "* '''Tool's reasoning:'''"]) {
    const at = body.indexOf(line);
    assert.ok(at > open && at < close, `${line} belongs inside the collapse box`);
  }
});

test('buildTalkSectionBody keeps the editor explanation label outside the collapse box', () => {
  const body = buildTalkSectionBody(CONTEXT);
  assert.match(body, new RegExp(`'''${EDITOR_EXPLANATION_LABEL}:'''`));
  assert.ok(
    body.indexOf(`'''${EDITOR_EXPLANATION_LABEL}:'''`) > body.indexOf('{{hidden end}}'),
    'the editor writes below the collapsed machine context, not inside it',
  );
});

test('buildTalkSectionBody omits the collapse box when the tool reported nothing', () => {
  const body = buildTalkSectionBody({ checkId: 'a7f3k2q9' });
  assert.equal(body.includes('{{hidden begin'), false);
  assert.equal(body.includes('{{hidden end}}'), false);
  assert.match(body, new RegExp(`'''${EDITOR_EXPLANATION_LABEL}:'''`));
});

test('buildTalkSectionBody ends with the machine-readable check id', () => {
  assert.match(buildTalkSectionBody(CONTEXT), /<!-- source-verifier check: a7f3k2q9 -->$/);
});

test('buildTalkSectionBody includes a corrected verdict when one was chosen', () => {
  const body = buildTalkSectionBody({ ...CONTEXT, correctedVerdict: 'SUPPORTED' });
  assert.match(body, /'''Editor says it should be:''' SUPPORTED/);
});

test("buildTalkSectionBody keeps the corrected verdict visible, not collapsed", () => {
  const body = buildTalkSectionBody({ ...CONTEXT, correctedVerdict: 'SUPPORTED' });
  assert.ok(
    body.indexOf("'''Editor says it should be:'''") > body.indexOf('{{hidden end}}'),
    'the editor\'s correction is the point of the section — it must not be hidden',
  );
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
