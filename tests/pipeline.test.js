import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyCitation, VERIFY_STAGES } from '../core/pipeline.js';
import { QUOTE_STATUSES } from '../core/quote.js';
import { VERDICTS } from '../core/verdicts.js';

const SOURCE_BODY = 'Acme Corp was established in 1985. Its founder, John Smith, served as CEO until 2001.';
const FRAMED = `Source URL: https://example.com/a\n\nSource Content:\n${SOURCE_BODY}`;

function fetchOk(content = FRAMED, status = 200) {
  return async () => ({ content, error: null, status });
}

function respond(payload, usage = { input: 10, output: 20, cost_usd: null }) {
  return async () => ({ text: JSON.stringify(payload), usage });
}

const SUPPORTED = {
  support_score: 95,
  verdict: 'SUPPORTED',
  source_quote: 'Its founder, John Smith, served as CEO until 2001.',
  comments: 'Definitive match.',
};

test('a supported claim comes back with the verdict, score and located quote', async () => {
  const result = await verifyCitation({
    claimText: 'The company was founded in 1985 by John Smith.',
    sourceUrl: 'https://example.com/a',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    fetchSource: fetchOk(),
    callProvider: respond(SUPPORTED),
  });

  assert.equal(result.ok, true);
  assert.equal(result.claimText, 'The company was founded in 1985 by John Smith.');
  assert.equal(result.verdict, VERDICTS.SUPPORTED);
  assert.equal(result.supportScore, 95);
  assert.equal(result.comments, 'Definitive match.');
  assert.equal(result.reasonType, null);
  assert.equal(result.provider, 'claude');
  assert.equal(result.model, 'claude-sonnet-4-6');
  assert.equal(result.sourceStatus, 200);
  assert.deepEqual(result.usage, { input: 10, output: 20, cost_usd: null });
  // The framing is stripped before the quote is looked up.
  assert.equal(result.sourceText, SOURCE_BODY);
  assert.equal(result.quote.verified, true);
  assert.equal(result.quote.verifiedText, SUPPORTED.source_quote);
});

test('a quote the source does not contain is reported unverified, not thrown away silently', async () => {
  const result = await verifyCitation({
    claimText: 'The company was founded in 1985.',
    sourceUrl: 'https://example.com/a',
    provider: 'claude',
    fetchSource: fetchOk(),
    callProvider: respond({ ...SUPPORTED, source_quote: 'A sentence the source never contained at all.' }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.quote.verified, false);
  assert.equal(result.quote.status, QUOTE_STATUSES.NOT_FOUND);
  // The raw model quote is still carried, for logging; renderers use
  // quote.verifiedText, which stays empty.
  assert.equal(result.sourceQuote, 'A sentence the source never contained at all.');
  assert.equal(result.quote.verifiedText, '');
});

test('reason_type survives on a NOT SUPPORTED verdict', async () => {
  const result = await verifyCitation({
    claimText: 'She received the Nobel Prize in 2015.',
    sourceUrl: 'https://example.com/a',
    provider: 'openai',
    fetchSource: fetchOk(),
    callProvider: respond({
      support_score: 10, verdict: 'NOT SUPPORTED', reason_type: 'omission',
      source_quote: '', comments: 'No mention of a Nobel Prize.',
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.verdict, VERDICTS.NOT_SUPPORTED);
  assert.equal(result.reasonType, 'omission');
  assert.equal(result.quote.status, QUOTE_STATUSES.EMPTY);
});

test('supplied source text skips the fetch entirely', async () => {
  let fetched = false;
  const result = await verifyCitation({
    claimText: 'The company was founded in 1985.',
    sourceUrl: 'https://example.com/a',
    sourceContent: `Manual source text:\n${SOURCE_BODY}`,
    provider: 'claude',
    fetchSource: async () => { fetched = true; return { content: null, error: 'nope', status: null }; },
    callProvider: respond(SUPPORTED),
  });

  assert.equal(fetched, false, 'a pasted source must not trigger a proxy fetch');
  assert.equal(result.ok, true);
  assert.equal(result.sourceText, SOURCE_BODY);
  assert.equal(result.quote.verified, true);
});

test('an unfetchable source fails at the source stage, carrying the upstream status', async () => {
  const result = await verifyCitation({
    claimText: 'A claim.',
    sourceUrl: 'https://example.com/dead',
    provider: 'claude',
    fetchSource: async () => ({ content: null, error: 'Paywalled', status: 403 }),
    callProvider: () => { throw new Error('must not be called'); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, VERIFY_STAGES.SOURCE);
  assert.equal(result.error, 'Paywalled');
  assert.equal(result.status, 403);
});

test('no URL and no pasted text fails at the source stage without any network call', async () => {
  const result = await verifyCitation({
    claimText: 'A claim.',
    provider: 'claude',
    fetchSource: () => { throw new Error('must not be called'); },
    callProvider: () => { throw new Error('must not be called'); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, VERIFY_STAGES.SOURCE);
  assert.equal(result.sourceUrl, null);
});

test('a provider failure is returned, not thrown, with the original error attached', async () => {
  const boom = new Error('API request failed (429): rate limited');
  const result = await verifyCitation({
    claimText: 'A claim.',
    sourceUrl: 'https://example.com/a',
    provider: 'openai',
    fetchSource: fetchOk(),
    callProvider: async () => { throw boom; },
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, VERIFY_STAGES.PROVIDER);
  assert.equal(result.error, 'API request failed (429): rate limited');
  // cli/verify.js classifies exit codes off the message shape, so the
  // original error has to survive the trip.
  assert.equal(result.cause, boom);
  assert.equal(result.sourceContent, FRAMED);
});

test('unparseable model output fails at the parse stage and keeps the raw text', async () => {
  const result = await verifyCitation({
    claimText: 'A claim.',
    sourceUrl: 'https://example.com/a',
    provider: 'publicai',
    fetchSource: fetchOk(),
    callProvider: async () => ({ text: 'I am afraid I cannot help with that.', usage: null }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, VERIFY_STAGES.PARSE);
  assert.equal(result.raw, 'I am afraid I cannot help with that.');
});

test('a caller-supplied system prompt is used verbatim', async () => {
  let seen = null;
  await verifyCitation({
    claimText: 'A claim.',
    sourceUrl: 'https://example.com/a',
    provider: 'claude',
    systemPrompt: 'LOCALIZED PROMPT',
    fetchSource: fetchOk(),
    callProvider: async (_name, config) => { seen = config; return { text: JSON.stringify(SUPPORTED) }; },
  });

  assert.equal(seen.systemPrompt, 'LOCALIZED PROMPT');
  assert.match(seen.userContent, /^Claim: "A claim\."/);
  assert.match(seen.userContent, /Acme Corp was established in 1985/);
});

test('workerBase is threaded to both the fetch and the model call only when overridden', async () => {
  let fetchOpts = null;
  let providerConfig = null;
  const spy = {
    fetchSource: async (_u, _p, opts) => { fetchOpts = opts; return { content: FRAMED, status: 200 }; },
    callProvider: async (_n, config) => { providerConfig = config; return { text: JSON.stringify(SUPPORTED) }; },
  };

  await verifyCitation({ claimText: 'c', sourceUrl: 'https://e.com', provider: 'huggingface', ...spy });
  assert.deepEqual(fetchOpts, {}, 'default routing must not pin a workerBase');
  assert.equal('workerBase' in providerConfig, false);

  await verifyCitation({
    claimText: 'c', sourceUrl: 'https://e.com', provider: 'huggingface',
    workerBase: 'https://llm-router.toolforge.org', ...spy,
  });
  assert.deepEqual(fetchOpts, { workerBase: 'https://llm-router.toolforge.org' });
  assert.equal(providerConfig.workerBase, 'https://llm-router.toolforge.org');
});

test('a missing claim or provider is a programmer error, not a result', async () => {
  await assert.rejects(() => verifyCitation({ provider: 'claude' }), TypeError);
  await assert.rejects(() => verifyCitation({ claimText: 'c' }), TypeError);
});
