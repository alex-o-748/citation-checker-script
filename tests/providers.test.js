import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  callPublicAIAPI,
  callHuggingFaceAPI,
  callClaudeAPI,
  callGeminiAPI,
  callOpenRouterAPI,
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

test('callHuggingFaceAPI posts to workerBase /hf and returns text + usage', async () => {
  const mock = withMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'hf-verdict' } }],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    }),
  }));
  try {
    const result = await callHuggingFaceAPI({
      model: 'meta-llama/Llama-3.3-70B-Instruct',
      systemPrompt: 's',
      userContent: 'u',
    });
    assert.equal(result.text, 'hf-verdict');
    assert.equal(result.usage.input, 50);
    assert.equal(result.usage.output, 10);
    assert.equal(mock.calls[0].url, 'https://publicai-proxy.alaexis.workers.dev/hf');
    const sent = JSON.parse(mock.calls[0].opts.body);
    assert.equal(sent.model, 'meta-llama/Llama-3.3-70B-Instruct');
  } finally {
    mock.restore();
  }
});

test('callHuggingFaceAPI with apiKey hits HF router with Bearer header', async () => {
  const mock = withMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'hf-direct' } }],
      usage: { prompt_tokens: 30, completion_tokens: 5 },
    }),
  }));
  try {
    const result = await callHuggingFaceAPI({
      apiKey: 'hf_test_key',
      model: 'meta-llama/Llama-3.3-70B-Instruct',
      systemPrompt: 's',
      userContent: 'u',
    });
    assert.equal(result.text, 'hf-direct');
    assert.equal(mock.calls[0].url, 'https://router.huggingface.co/v1/chat/completions');
    assert.equal(mock.calls[0].opts.headers['Authorization'], 'Bearer hf_test_key');
  } finally {
    mock.restore();
  }
});

test('callHuggingFaceAPI without apiKey omits Authorization header', async () => {
  const mock = withMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'ok' } }],
      usage: {},
    }),
  }));
  try {
    await callHuggingFaceAPI({ model: 'm', systemPrompt: 's', userContent: 'u' });
    assert.equal(mock.calls[0].url, 'https://publicai-proxy.alaexis.workers.dev/hf');
    assert.equal(mock.calls[0].opts.headers['Authorization'], undefined);
  } finally {
    mock.restore();
  }
});

test('callHuggingFaceAPI returns usage.cost_usd: null (HF does not surface per-call cost)', async () => {
  const mock = withMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 40, completion_tokens: 8 },
    }),
  }));
  try {
    const result = await callHuggingFaceAPI({ model: 'm', systemPrompt: 's', userContent: 'u' });
    assert.equal(result.usage.cost_usd, null);
    assert.equal(result.usage.input, 40);
    assert.equal(result.usage.output, 8);
  } finally {
    mock.restore();
  }
});

test('callHuggingFaceAPI surfaces upstream error messages', async () => {
  const mock = withMockFetch(async () => ({
    ok: false,
    status: 429,
    text: async () => JSON.stringify({ error: { message: 'rate limited' } }),
  }));
  try {
    await assert.rejects(
      () => callHuggingFaceAPI({ model: 'm', systemPrompt: 's', userContent: 'u' }),
      /HuggingFace API request failed \(429\): rate limited/
    );
  } finally {
    mock.restore();
  }
});

test('callProviderAPI dispatches huggingface to /hf', async () => {
  const mock = withMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'ok' } }],
      usage: {},
    }),
  }));
  try {
    await callProviderAPI('huggingface', {
      model: 'meta-llama/Llama-3.3-70B-Instruct',
      systemPrompt: 's',
      userContent: 'u',
    });
    assert.ok(mock.calls[0].url.endsWith('/hf'));
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

test('callGeminiAPI requests JSON-only output via responseMimeType', async () => {
  // Issue #75: Gemini occasionally emits prose, markdown-fenced JSON, or
  // truncated JSON which the verdict parser then fails to read. Setting
  // responseMimeType: application/json constrains Gemini to emit syntactically
  // valid JSON, recovering parse-failed rows.
  const mock = withMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: '{"verdict":"Supported"}' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }),
  }));
  try {
    await callGeminiAPI({
      apiKey: 'k',
      model: 'gemini-2.5-flash',
      systemPrompt: 's',
      userContent: 'u',
    });
    const body = JSON.parse(mock.calls[0].opts.body);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
  } finally {
    mock.restore();
  }
});

test('callOpenRouterAPI hits OpenRouter API with attribution headers and surfaces cost', async () => {
  const mock = withMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'or-verdict' } }],
      usage: { prompt_tokens: 80, completion_tokens: 12, cost: 0.000345 },
    }),
  }));
  try {
    const result = await callOpenRouterAPI({
      apiKey: 'or_test_key',
      model: 'qwen/qwen3-32b',
      systemPrompt: 's',
      userContent: 'u',
    });
    assert.equal(result.text, 'or-verdict');
    assert.equal(result.usage.input, 80);
    assert.equal(result.usage.output, 12);
    assert.equal(result.usage.cost_usd, 0.000345);
    assert.equal(mock.calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(mock.calls[0].opts.headers['Authorization'], 'Bearer or_test_key');
    assert.ok(mock.calls[0].opts.headers['HTTP-Referer']);
    assert.ok(mock.calls[0].opts.headers['X-Title']);
  } finally {
    mock.restore();
  }
});

test('callOpenRouterAPI forwards responseFormat as request_body.response_format', async () => {
  const mock = withMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: '{"verdict":"SUPPORTED"}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
  }));
  try {
    await callOpenRouterAPI({
      apiKey: 'k',
      model: 'ibm-granite/granite-4.1-8b',
      systemPrompt: 's',
      userContent: 'u',
      responseFormat: { type: 'json_object' },
    });
    const body = JSON.parse(mock.calls[0].opts.body);
    assert.deepEqual(body.response_format, { type: 'json_object' });
  } finally {
    mock.restore();
  }
});

test('callOpenRouterAPI omits response_format when not supplied', async () => {
  const mock = withMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'x' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
  }));
  try {
    await callOpenRouterAPI({ apiKey: 'k', model: 'm', systemPrompt: 's', userContent: 'u' });
    const body = JSON.parse(mock.calls[0].opts.body);
    assert.equal(body.response_format, undefined);
  } finally {
    mock.restore();
  }
});

test('callOpenRouterAPI returns cost_usd: null when usage.cost missing', async () => {
  const mock = withMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'no-cost' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
  }));
  try {
    const result = await callOpenRouterAPI({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userContent: 'u',
    });
    assert.equal(result.usage.cost_usd, null);
  } finally {
    mock.restore();
  }
});

test('callOpenRouterAPI forwards extraBody fields into the request body', async () => {
  const mock = withMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  }));
  try {
    await callOpenRouterAPI({
      apiKey: 'k',
      model: 'nvidia/nemotron-nano-9b-v2',
      systemPrompt: 's',
      userContent: 'u',
      extraBody: { reasoning: { enabled: false } },
    });
    const body = JSON.parse(mock.calls[0].opts.body);
    assert.deepEqual(body.reasoning, { enabled: false });
    assert.equal(body.model, 'nvidia/nemotron-nano-9b-v2');
  } finally {
    mock.restore();
  }
});

test('callOpenRouterAPI omits extraBody fields when not provided', async () => {
  const mock = withMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  }));
  try {
    await callOpenRouterAPI({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userContent: 'u',
    });
    const body = JSON.parse(mock.calls[0].opts.body);
    assert.equal(body.reasoning, undefined);
  } finally {
    mock.restore();
  }
});

test('callOpenRouterAPI surfaces upstream error messages', async () => {
  const mock = withMockFetch(async () => ({
    ok: false,
    status: 402,
    text: async () => JSON.stringify({ error: { message: 'insufficient credits' } }),
  }));
  try {
    await assert.rejects(
      () => callOpenRouterAPI({ apiKey: 'k', model: 'm', systemPrompt: 's', userContent: 'u' }),
      /OpenRouter API request failed \(402\): insufficient credits/
    );
  } finally {
    mock.restore();
  }
});

test('callProviderAPI dispatches openrouter to OpenRouter API', async () => {
  const mock = withMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'via-dispatcher' } }],
      usage: {},
    }),
  }));
  try {
    const result = await callProviderAPI('openrouter', {
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userContent: 'u',
    });
    assert.equal(result.text, 'via-dispatcher');
    assert.ok(mock.calls[0].url.startsWith('https://openrouter.ai/'));
  } finally {
    mock.restore();
  }
});

test('callPublicAIAPI honors maxTokens parameter (overrides default)', async () => {
  const mock = withMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'ok' } }],
      usage: {},
    }),
  }));
  try {
    await callPublicAIAPI({
      model: 'm',
      systemPrompt: 's',
      userContent: 'u',
      maxTokens: 500,
    });
    const sent = JSON.parse(mock.calls[0].opts.body);
    assert.equal(sent.max_tokens, 500);
  } finally {
    mock.restore();
  }
});

test('callClaudeAPI honors maxTokens parameter', async () => {
  const mock = withMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ text: 'ok' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
  }));
  try {
    await callClaudeAPI({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userContent: 'u',
      maxTokens: 750,
    });
    const sent = JSON.parse(mock.calls[0].opts.body);
    assert.equal(sent.max_tokens, 750);
  } finally {
    mock.restore();
  }
});

test('callGeminiAPI honors maxTokens parameter (maps to maxOutputTokens)', async () => {
  const mock = withMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: {},
    }),
  }));
  try {
    await callGeminiAPI({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userContent: 'u',
      maxTokens: 1100,
    });
    const sent = JSON.parse(mock.calls[0].opts.body);
    assert.equal(sent.generationConfig.maxOutputTokens, 1100);
  } finally {
    mock.restore();
  }
});

test('callOpenAIAPI honors maxTokens parameter', async () => {
  const mock = withMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'ok' } }],
      usage: {},
    }),
  }));
  try {
    const { callOpenAIAPI } = await import('../core/providers.js');
    await callOpenAIAPI({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userContent: 'u',
      maxTokens: 600,
    });
    const sent = JSON.parse(mock.calls[0].opts.body);
    assert.equal(sent.max_tokens, 600);
  } finally {
    mock.restore();
  }
});

test('callOpenAICompatibleChat-based providers honor temperature parameter (default 0.1)', async () => {
  // Default temperature = 0.1
  let mock = withMockFetch(async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }),
  }));
  try {
    await callPublicAIAPI({ model: 'm', systemPrompt: 's', userContent: 'u' });
    let sent = JSON.parse(mock.calls[0].opts.body);
    assert.equal(sent.temperature, 0.1);
  } finally {
    mock.restore();
  }

  // Override via temperature parameter
  mock = withMockFetch(async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }),
  }));
  try {
    await callPublicAIAPI({ model: 'm', systemPrompt: 's', userContent: 'u', temperature: 0.5 });
    let sent = JSON.parse(mock.calls[0].opts.body);
    assert.equal(sent.temperature, 0.5);
  } finally {
    mock.restore();
  }
});

test('callOpenAIAPI honors temperature parameter (default 0.1, override works)', async () => {
  const { callOpenAIAPI } = await import('../core/providers.js');
  const mock = withMockFetch(async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }),
  }));
  try {
    await callOpenAIAPI({
      apiKey: 'k', model: 'm', systemPrompt: 's', userContent: 'u', temperature: 0.3,
    });
    const sent = JSON.parse(mock.calls[0].opts.body);
    assert.equal(sent.temperature, 0.3);
  } finally {
    mock.restore();
  }
});

test('callGeminiAPI default temperature is 0.1 (was 0.0; aligned with other providers)', async () => {
  const mock = withMockFetch(async () => ({
    ok: true, status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: {},
    }),
  }));
  try {
    await callGeminiAPI({
      apiKey: 'k', model: 'm', systemPrompt: 's', userContent: 'u',
    });
    const body = JSON.parse(mock.calls[0].opts.body);
    assert.equal(body.generationConfig.temperature, 0.1);
  } finally {
    mock.restore();
  }
});

test('callGeminiAPI honors temperature parameter override', async () => {
  const mock = withMockFetch(async () => ({
    ok: true, status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: {},
    }),
  }));
  try {
    await callGeminiAPI({
      apiKey: 'k', model: 'm', systemPrompt: 's', userContent: 'u', temperature: 0.7,
    });
    const body = JSON.parse(mock.calls[0].opts.body);
    assert.equal(body.generationConfig.temperature, 0.7);
  } finally {
    mock.restore();
  }
});

test('callGeminiAPI uses structured systemInstruction + contents by default', async () => {
  const mock = withMockFetch(async () => ({
    ok: true, status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: {},
    }),
  }));
  try {
    await callGeminiAPI({
      apiKey: 'k', model: 'm', systemPrompt: 'SYS', userContent: 'USR',
    });
    const body = JSON.parse(mock.calls[0].opts.body);
    assert.deepEqual(body.systemInstruction, { parts: [{ text: 'SYS' }] });
    assert.deepEqual(body.contents, [{ parts: [{ text: 'USR' }] }]);
  } finally {
    mock.restore();
  }
});

test('callGeminiAPI with useStructuredPrompt:false concatenates system+user', async () => {
  const mock = withMockFetch(async () => ({
    ok: true, status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: {},
    }),
  }));
  try {
    await callGeminiAPI({
      apiKey: 'k', model: 'm', systemPrompt: 'SYS', userContent: 'USR',
      useStructuredPrompt: false,
    });
    const body = JSON.parse(mock.calls[0].opts.body);
    assert.equal(body.systemInstruction, undefined);
    assert.deepEqual(body.contents, [{ parts: [{ text: 'SYS\n\nUSR' }] }]);
  } finally {
    mock.restore();
  }
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
