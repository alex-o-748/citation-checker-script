// Characterization tests for benchmark/run_benchmark.js's callProvider.
//
// Asserts the unified contract that every provider type produces:
//   { verdict, confidence, comments, raw_response, usage: { input, output, cost_usd }, latency, error }
//
// Pre-refactor, callProvider used Node's `https` module per provider, returned
// { verdict, ... } without a usage field, and routed through a local httpPost
// helper. Post-refactor, callProvider delegates to core/providers.js (which
// uses fetch), giving every provider a consistent usage shape including
// cost_usd: null where the upstream API doesn't expose per-call cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callProvider, PROVIDERS, registerAdHocHfProvider, hostForProvider } from '../benchmark/run_benchmark.js';

function withMockFetch(handler) {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, opts) => {
        calls.push({ url, opts });
        return handler(url, opts);
    };
    return {
        calls,
        restore: () => { globalThis.fetch = original; },
    };
}

const VERDICT_JSON = '{"verdict":"SUPPORTED","confidence":85,"comments":"clear match"}';

function withEnv(vars, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return fn().finally(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });
}

test('callProvider publicai returns parsed verdict and usage shape, max_tokens=16384', async () => {
    const mock = withMockFetch(async () => ({
        ok: true, status: 200,
        json: async () => ({
            choices: [{ message: { content: VERDICT_JSON } }],
            usage: { prompt_tokens: 120, completion_tokens: 18 },
        }),
    }));
    try {
        await withEnv({ PUBLICAI_API_KEY: 'test' }, async () => {
            const result = await callProvider('apertus-70b', 'sys', 'user');
            assert.equal(result.verdict, 'Supported');
            assert.equal(result.confidence, 85);
            assert.equal(result.comments, 'clear match');
            assert.equal(result.usage.input, 120);
            assert.equal(result.usage.output, 18);
            assert.equal(result.usage.cost_usd, null);
            assert.equal(result.error, null);
            assert.equal(typeof result.latency, 'number');
            // Benchmark max_tokens matches core/providers.js (16384) so the
            // benchmark measures what the userscript and CLI actually run.
            // It was 1000 until 2026-08-16, which truncated reasoning models
            // mid-reasoning and scored them as errors — see BENCHMARK_MAX_TOKENS.
            const sent = JSON.parse(mock.calls[0].opts.body);
            assert.equal(sent.max_tokens, 16384);
        });
    } finally {
        mock.restore();
    }
});

test('callProvider claude returns parsed verdict and usage shape', async () => {
    const mock = withMockFetch(async () => ({
        ok: true, status: 200,
        json: async () => ({
            content: [{ text: VERDICT_JSON }],
            usage: { input_tokens: 200, output_tokens: 30 },
        }),
    }));
    try {
        await withEnv({ ANTHROPIC_API_KEY: 'test' }, async () => {
            const result = await callProvider('claude-sonnet-4-5', 'sys', 'user');
            assert.equal(result.verdict, 'Supported');
            assert.equal(result.usage.input, 200);
            assert.equal(result.usage.output, 30);
            assert.equal(result.usage.cost_usd, null);
            assert.equal(result.error, null);
            // Sonnet 4.5 doesn't support the effort ladder (400s if sent) — the
            // provider config carries no `effort` field, so none should be sent.
            const sent = JSON.parse(mock.calls[0].opts.body);
            assert.equal(sent.output_config, undefined);
        });
    } finally {
        mock.restore();
    }
});

test('callProvider claude-sonnet-5 sends effort: medium', async () => {
    const mock = withMockFetch(async () => ({
        ok: true, status: 200,
        json: async () => ({
            content: [{ text: VERDICT_JSON }],
            usage: { input_tokens: 200, output_tokens: 30 },
        }),
    }));
    try {
        await withEnv({ ANTHROPIC_API_KEY: 'test' }, async () => {
            const result = await callProvider('claude-sonnet-5', 'sys', 'user');
            assert.equal(result.verdict, 'Supported');
            assert.equal(result.error, null);
            const sent = JSON.parse(mock.calls[0].opts.body);
            assert.deepEqual(sent.output_config, { effort: 'medium' });
        });
    } finally {
        mock.restore();
    }
});

test('callProvider gemini returns parsed verdict and usage shape', async () => {
    const mock = withMockFetch(async () => ({
        ok: true, status: 200,
        json: async () => ({
            candidates: [{ content: { parts: [{ text: VERDICT_JSON }] } }],
            usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 14 },
        }),
    }));
    try {
        await withEnv({ GEMINI_API_KEY: 'test' }, async () => {
            const result = await callProvider('gemini-2.5-flash', 'sys', 'user');
            assert.equal(result.verdict, 'Supported');
            assert.equal(result.usage.input, 90);
            assert.equal(result.usage.output, 14);
            assert.equal(result.usage.cost_usd, null);
            assert.equal(result.error, null);
        });
    } finally {
        mock.restore();
    }
});

test('callProvider returns ERROR shape when env var is missing', async () => {
    await withEnv({ PUBLICAI_API_KEY: undefined }, async () => {
        const result = await callProvider('apertus-70b', 'sys', 'user');
        assert.equal(result.verdict, 'ERROR');
        assert.match(result.error, /PUBLICAI_API_KEY/);
        assert.equal(typeof result.latency, 'number');
    });
});

// ---- Hugging Face: keyless mode ---------------------------------------------

test('callProvider hf-* without HF_TOKEN routes through the keyless proxy /hf path', async () => {
    const mock = withMockFetch(async () => ({
        ok: true, status: 200,
        json: async () => ({
            choices: [{ message: { content: VERDICT_JSON } }],
            usage: { prompt_tokens: 40, completion_tokens: 8 },
        }),
    }));
    try {
        await withEnv({ HF_TOKEN: undefined }, async () => {
            const result = await callProvider('hf-qwen3-32b', 'sys', 'user');
            assert.equal(result.error, null);
            assert.equal(result.verdict, 'Supported');
            assert.equal(mock.calls[0].url, 'https://publicai-proxy.alaexis.workers.dev/hf');
            assert.equal(mock.calls[0].opts.headers['Authorization'], undefined);
        });
    } finally {
        mock.restore();
    }
});

test('callProvider hf-* with HF_TOKEN calls the HF router directly', async () => {
    const mock = withMockFetch(async () => ({
        ok: true, status: 200,
        json: async () => ({
            choices: [{ message: { content: VERDICT_JSON } }],
            usage: { prompt_tokens: 40, completion_tokens: 8 },
        }),
    }));
    try {
        await withEnv({ HF_TOKEN: 'hf_test' }, async () => {
            const result = await callProvider('hf-qwen3-32b', 'sys', 'user');
            assert.equal(result.error, null);
            assert.equal(mock.calls[0].url, 'https://router.huggingface.co/v1/chat/completions');
            assert.equal(mock.calls[0].opts.headers['Authorization'], 'Bearer hf_test');
        });
    } finally {
        mock.restore();
    }
});

// ---- Hugging Face: ad-hoc hf:<model-id> providers ---------------------------

test('registerAdHocHfProvider registers a keyless huggingface provider for the given model', () => {
    const key = registerAdHocHfProvider('hf:meta-llama/Llama-3.3-70B-Instruct');
    assert.equal(key, 'hf:meta-llama/Llama-3.3-70B-Instruct');
    assert.deepEqual(PROVIDERS[key], {
        name: 'meta-llama/Llama-3.3-70B-Instruct (HF Inference)',
        model: 'meta-llama/Llama-3.3-70B-Instruct',
        endpoint: 'https://router.huggingface.co/v1/chat/completions',
        requiresKey: false,
        keyEnv: 'HF_TOKEN',
        type: 'huggingface',
    });
    // hostForProvider works the same as any predefined provider.
    assert.equal(hostForProvider(key), 'router.huggingface.co');
});

test('registerAdHocHfProvider rejects a spec with no model id', () => {
    assert.throws(() => registerAdHocHfProvider('hf:'), /expected hf:<model-id>/);
});

test('registerAdHocHfProvider is idempotent for the same model id', () => {
    const first = registerAdHocHfProvider('hf:idempotent/test-model');
    const second = registerAdHocHfProvider('hf:idempotent/test-model');
    assert.equal(first, second);
    assert.equal(Object.keys(PROVIDERS).filter(k => k === first).length, 1);
});

test('callProvider works end-to-end for an ad-hoc hf:<model-id> provider, keyless', async () => {
    const mock = withMockFetch(async () => ({
        ok: true, status: 200,
        json: async () => ({
            choices: [{ message: { content: VERDICT_JSON } }],
            usage: { prompt_tokens: 25, completion_tokens: 6 },
        }),
    }));
    try {
        await withEnv({ HF_TOKEN: undefined }, async () => {
            const key = registerAdHocHfProvider('hf:mistralai/Mistral-Small-24B-Instruct-2501');
            const result = await callProvider(key, 'sys', 'user');
            assert.equal(result.error, null);
            assert.equal(result.verdict, 'Supported');
            assert.equal(mock.calls[0].url, 'https://publicai-proxy.alaexis.workers.dev/hf');
            const sent = JSON.parse(mock.calls[0].opts.body);
            assert.equal(sent.model, 'mistralai/Mistral-Small-24B-Instruct-2501');
        });
    } finally {
        mock.restore();
    }
});
