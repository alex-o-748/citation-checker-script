// LLM provider dispatch. Pure HTTP routing — callers build the prompt.

// Attach the HTTP status to a thrown error so retry logic can classify it
// structurally instead of pattern-matching prose. isRetryableError() reads
// `.status` first; matching on message text alone is what let a formatting
// difference silently disable 429 retries for every provider here.
function httpError(message, status) {
    const error = new Error(message);
    error.status = status;
    return error;
}

// Shared call shape for OpenAI-compatible chat-completion upstreams.
// Used by PublicAI/HF (proxy-routed; key injected upstream), HF when the
// caller supplies their own bearer token (direct call to the HF router),
// OpenRouter (which adds attribution headers and surfaces per-call cost),
// and the benchmark runner (which calls direct PublicAI/OpenAI endpoints
// with bearer auth from environment variables).
// `responseFormat` is OpenAI-compatible structured-output: pass
// `{ type: 'json_object' }` to force JSON-only output, or a JSON-schema
// object on backends that support it. OpenRouter passes the param
// through to the underlying model; backends that don't recognise it
// generally ignore it rather than error. Small / weaker instruction-tuned
// models benefit most — Granite 4.1 8B in particular regressed from
// ~0.5% to 13% JSON-parse failures under terser prompts until this
// hint was supplied, after which parse failures returned to 0.
// maxTokens default is deliberately generous (16384): reasoning models such as
// gpt-oss spend output tokens on hidden reasoning *before* writing the answer,
// and a hard claim over a long source can burn several thousand tokens
// reasoning. At the old 2048 default the budget ran out mid-reasoning, so the
// model returned finish_reason "length" with empty content (surfacing as the
// opaque "Invalid API response format"). Reasoning length is also stochastic —
// the same request measured anywhere from ~1.5k to ~4k reasoning tokens — so
// the ceiling needs comfortable headroom, not just enough for the average case.
// 16384 is ~4x the observed worst case. Only tokens actually generated are
// billed, non-reasoning models stop well before the ceiling, and OpenAI-
// compatible endpoints clamp an over-large max_tokens to the model's own limit
// rather than erroring — so this larger default is safe for every shared caller.
export async function callOpenAICompatibleChat({ url, apiKey, model, systemPrompt, userContent, label, extraHeaders, extraBody, maxTokens = 16384, temperature = 0.1, responseFormat }) {
    const requestBody = {
        model: model,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent }
        ],
        max_tokens: maxTokens,
        temperature: temperature
    };
    if (extraBody) Object.assign(requestBody, extraBody);
    if (responseFormat) requestBody.response_format = responseFormat;

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (extraHeaders) Object.assign(headers, extraHeaders);

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorText = await response.text();
        let errorMessage;
        try {
            const errorData = JSON.parse(errorText);
            errorMessage = errorData.error?.message || errorText;
        } catch {
            errorMessage = errorText;
        }
        // 413 is a byte cap on the request body (the CORS proxy rejects the
        // request before the model sees it), not a model context limit — so the
        // fix is a shorter source or a provider that calls its API directly
        // rather than through the size-limited proxy.
        if (response.status === 413) {
            throw new Error(`${label}: the source is too large to send. Trim the source text, or switch to a provider that calls its API directly (Claude, Gemini, or OpenAI).`);
        }
        throw httpError(`${label} API request failed (${response.status}): ${errorMessage}`, response.status);
    }

    const data = await response.json();

    const choice = data.choices?.[0];
    if (!choice?.message?.content) {
        // Reasoning models (e.g. gpt-oss) emit hidden reasoning before the
        // answer; if the output budget runs out mid-reasoning the response
        // comes back with finish_reason "length" and empty content. Name that
        // failure specifically so the user knows to raise the budget / simplify
        // the claim rather than assume the source or provider is broken.
        if (choice?.finish_reason === 'length') {
            throw new Error(`${label}: the model ran out of output budget (${maxTokens} tokens) before answering — it spent the whole budget reasoning. Try a shorter source, a simpler claim, or a non-reasoning provider.`);
        }
        throw new Error(`Invalid API response format (${label}: no content${choice?.finish_reason ? `, finish_reason "${choice.finish_reason}"` : ''})`);
    }

    return {
        text: data.choices[0].message.content,
        usage: {
            input: data.usage?.prompt_tokens || 0,
            output: data.usage?.completion_tokens || 0,
            cost_usd: data.usage?.cost ?? null
        }
    };
}

export async function callPublicAIAPI({ apiKey, model, systemPrompt, userContent, workerBase = 'https://publicai-proxy.alaexis.workers.dev', maxTokens, temperature }) {
    return callOpenAICompatibleChat({
        url: workerBase,
        apiKey,
        model, systemPrompt, userContent, maxTokens, temperature,
        label: 'PublicAI',
    });
}

// HF direct router endpoint, used when the caller supplies an apiKey.
// Without one, the call falls back to the worker proxy's /hf path, which
// injects an upstream key on the user's behalf.
const HF_DIRECT_URL = 'https://router.huggingface.co/v1/chat/completions';

export async function callHuggingFaceAPI({ apiKey, model, systemPrompt, userContent, workerBase = 'https://publicai-proxy.alaexis.workers.dev', maxTokens, temperature }) {
    const direct = Boolean(apiKey);
    return callOpenAICompatibleChat({
        url: direct ? HF_DIRECT_URL : `${workerBase}/hf`,
        apiKey: direct ? apiKey : undefined,
        model, systemPrompt, userContent, maxTokens, temperature,
        label: 'HuggingFace',
    });
}

// Wikimedia Lift Wing hosts open-weight models (Qwen3) on WMF infrastructure.
// Routed through the same CORS worker as PublicAI/HF, on the `/liftwing` path:
// the worker builds the upstream URL from the model id, works anonymously by
// default (an approved-bot JWT on the worker lifts the rate limit), and strips
// the reasoning models' <think>…</think> blocks from non-streaming responses so
// the verdict parser sees clean JSON. No apiKey — the worker holds any credential.
//
// maxTokens intentionally has no local default: Lift Wing and HF host the same
// class of reasoning model, so they inherit the same shared 16384 ceiling and
// every caller (userscript, CLI, benchmark) sends the two providers identical
// parameters. This previously defaulted to 4096 to match a worker-side clamp;
// if the worker still clamps below 16384 it will keep doing so regardless of
// what we send here, so the clamp belongs in the worker rather than as a
// client-side asymmetry that silently handicaps one provider.
export async function callLiftwingAPI({ model, systemPrompt, userContent, workerBase = 'https://publicai-proxy.alaexis.workers.dev', maxTokens, temperature }) {
    return callOpenAICompatibleChat({
        url: `${workerBase}/liftwing`,
        model, systemPrompt, userContent, maxTokens, temperature,
        label: 'Lift Wing',
    });
}

// OpenRouter routes OpenAI-compatible requests across many open-weight backends.
// Per-call USD cost is surfaced on response.usage.cost (no opt-in flag required
// as of 2026; the older `usage: { include: true }` parameter is deprecated).
// Attribution headers (HTTP-Referer + X-Title) are recommended by OpenRouter
// for analytics; they don't affect routing.
export async function callOpenRouterAPI({ apiKey, model, systemPrompt, userContent, maxTokens, temperature, extraBody, responseFormat }) {
    return callOpenAICompatibleChat({
        url: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey,
        model, systemPrompt, userContent, maxTokens, temperature, extraBody, responseFormat,
        label: 'OpenRouter',
        extraHeaders: {
            'HTTP-Referer': 'https://github.com/alex-o-748/citation-checker-script',
            'X-Title': 'citation-checker-script',
        },
    });
}

export async function callClaudeAPI({ apiKey, model, systemPrompt, userContent, maxTokens = 3000 }) {
    const requestBody = {
        model: model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }]
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw httpError(`API request failed (${response.status}): ${errorText}`, response.status);
    }

    const data = await response.json();
    return {
        text: data.content[0].text,
        usage: {
            input: data.usage?.input_tokens || 0,
            output: data.usage?.output_tokens || 0,
            cost_usd: null
        }
    };
}

export async function callGeminiAPI({ apiKey, model, systemPrompt, userContent, maxTokens = 2048, temperature = 0.1, useStructuredPrompt = true }) {
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    // useStructuredPrompt:true (default) uses Gemini's proper systemInstruction
    // + contents shape; the userscript and CLI have always used this.
    // useStructuredPrompt:false concatenates `${systemPrompt}\n\n${userContent}`
    // into a single user turn — the historical benchmark-runner shape, kept
    // available so past benchmark numbers stay reproducible until a deliberate
    // re-baselining run picks the canonical shape.
    const requestBody = useStructuredPrompt
        ? {
            contents: [{ parts: [{ text: userContent }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
        }
        : {
            contents: [{ parts: [{ text: `${systemPrompt}\n\n${userContent}` }] }],
        };
    requestBody.generationConfig = {
        maxOutputTokens: maxTokens,
        temperature: temperature,
        // responseMimeType: 'application/json' constrains Gemini to emit
        // syntactically valid JSON only. Without it, Gemini occasionally
        // wraps output in markdown fences or emits prose, both of which
        // the verdict parser fails on. See issue #75.
        responseMimeType: 'application/json'
    };

    const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
    });

    const responseData = await response.json();

    if (!response.ok) {
        const errorDetail = responseData.error?.message || response.statusText;
        throw httpError(`API request failed (${response.status}): ${errorDetail}`, response.status);
    }

    if (!responseData.candidates?.[0]?.content?.parts?.[0]?.text) {
        throw new Error('Invalid API response format or no content generated.');
    }

    return {
        text: responseData.candidates[0].content.parts[0].text,
        usage: {
            input: responseData.usageMetadata?.promptTokenCount || 0,
            output: responseData.usageMetadata?.candidatesTokenCount || 0,
            cost_usd: null
        }
    };
}

export async function callOpenAIAPI({ apiKey, model, systemPrompt, userContent, maxTokens = 2000, temperature = 0.1 }) {
    const requestBody = {
        model: model,
        max_tokens: maxTokens,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent }
        ],
        temperature: temperature
    };

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorText = await response.text();
        let errorMessage;
        try {
            const errorData = JSON.parse(errorText);
            errorMessage = errorData.error?.message || errorText;
        } catch {
            errorMessage = errorText;
        }
        throw httpError(`API request failed (${response.status}): ${errorMessage}`, response.status);
    }

    const data = await response.json();

    if (!data.choices?.[0]?.message?.content) {
        throw new Error('Invalid API response format');
    }

    return {
        text: data.choices[0].message.content,
        usage: {
            input: data.usage?.prompt_tokens || 0,
            output: data.usage?.completion_tokens || 0,
            cost_usd: null
        }
    };
}

export async function callProviderAPI(name, config) {
    switch (name) {
        case 'publicai':    return await callPublicAIAPI(config);
        case 'huggingface': return await callHuggingFaceAPI(config);
        case 'liftwing':    return await callLiftwingAPI(config);
        case 'openrouter':  return await callOpenRouterAPI(config);
        case 'claude':      return await callClaudeAPI(config);
        case 'gemini':      return await callGeminiAPI(config);
        case 'openai':      return await callOpenAIAPI(config);
        default: throw new Error(`Unknown provider: ${name}`);
    }
}
