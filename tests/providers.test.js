import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  callPublicAIAPI,
  callClaudeAPI,
  callProviderAPI,
} from '../core/providers.js';

function withMockFetch(fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return fn(url, opts);
  };
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
  };
}

test('callClaudeAPI sends Anthropic headers and parses response', async () => {
  const mock = withMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ text: 'OK' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  }));
  try {
    const result = await callClaudeAPI({
      apiKey: 'sk-test',
      model: 'claude-3-5-sonnet-20241022',
      systemPrompt: 'system',
      userContent: 'user',
    });
    assert.equal(result.text, 'OK');
    assert.equal(result.usage.input, 10);
    assert.equal(result.usage.output, 5);
    assert.equal(mock.calls[0].opts.headers['x-api-key'], 'sk-test');
  } finally {
    mock.restore();
  }
});

test('callPublicAIAPI posts to workerBase and returns text + usage', async () => {
  const mock = withMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'verdict' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }),
  }));
  try {
    const result = await callPublicAIAPI({
      model: 'qwen',
      systemPrompt: 's',
      userContent: 'u',
    });
    assert.equal(result.text, 'verdict');
    assert.ok(mock.calls[0].url.startsWith('https://publicai-proxy.alaexis.workers.dev'));
  } finally {
    mock.restore();
  }
});

test('callProviderAPI dispatches to the named provider', async () => {
  const mock = withMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ text: 'via-dispatcher' }], usage: {} }),
  }));
  try {
    const result = await callProviderAPI('claude', {
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userContent: 'u',
    });
    assert.equal(result.text, 'via-dispatcher');
  } finally {
    mock.restore();
  }
});

test('callProviderAPI throws on unknown provider', async () => {
  await assert.rejects(
    () => callProviderAPI('nope', {}),
    /Unknown provider: nope/
  );
});

test('callClaudeAPI throws on non-ok response', async () => {
  const mock = withMockFetch(async () => ({
    ok: false,
    status: 401,
    text: async () => 'unauthorized',
  }));
  try {
    await assert.rejects(
      () => callClaudeAPI({ apiKey: 'bad', model: 'm', systemPrompt: 's', userContent: 'u' }),
      /401/
    );
  } finally {
    mock.restore();
  }
});
