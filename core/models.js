// Single source of truth for "which providers exist and which model does each
// one call".
//
// This lived in three places at once: main.js's `this.providers` literal,
// cli/verify.js's PROVIDER_MODELS map, and (in the standalone web tool,
// alex-o-748/citation-checker) a fourth copy with its own, older model ids
// — which is how that tool ended up pinned to gemini-1.5-flash and a
// nonexistent claude-sonnet-4-5-20250514 long after this repo had moved on.
// Every consumer now reads this table, so bumping a model is a one-line
// change here rather than a hunt across repos.
//
// Fields:
//   name         Display name shown in provider pickers.
//   model        The model id passed to core/providers.js.
//   requiresKey  The provider cannot be called at all without a user key.
//   optionalKey  A key is not required (the worker proxy injects one
//                upstream), but supplying one switches to a direct call.
//   storageKey   localStorage key the userscript/web UI stores the key under,
//                or null for providers that never take one.
//   color        Accent color for provider-tinted UI (see main.js's
//                styleTokens()). Uniform today; kept per-provider because the
//                sidebar reads it per-provider.
//
// Note that `requiresKey` and `optionalKey` are not mutually exhaustive: a
// provider with both false (publicai, liftwing) is proxy-only and never
// accepts a user key.

export const PROVIDERS = Object.freeze({
    publicai: Object.freeze({
        name: 'PublicAI',
        storageKey: null, // No key needed - uses built-in key
        color: '#6B21A8',
        model: 'aisingapore/Qwen-SEA-LION-v4-32B-IT',
        requiresKey: false,
    }),
    huggingface: Object.freeze({
        name: 'HuggingFace',
        // Optional key: free via the proxy without one; direct call
        // to HF (any model) when stored.
        storageKey: 'hf_api_key',
        color: '#6B21A8',
        model: 'openai/gpt-oss-20b',
        requiresKey: false,
        optionalKey: true,
    }),
    liftwing: Object.freeze({
        name: 'Lift Wing',
        // No key needed - proxied through the CORS worker's /liftwing
        // path, which talks to Wikimedia Lift Wing anonymously (an
        // approved-bot JWT on the worker lifts the rate limit).
        storageKey: null,
        color: '#6B21A8',
        model: 'llm-qwen36-27b',
        requiresKey: false,
    }),
    claude: Object.freeze({
        name: 'Claude',
        storageKey: 'claude_api_key',
        color: '#6B21A8',
        model: 'claude-sonnet-4-6',
        requiresKey: true,
    }),
    gemini: Object.freeze({
        name: 'Gemini',
        storageKey: 'gemini_api_key',
        color: '#6B21A8',
        model: 'gemini-flash-latest',
        requiresKey: true,
    }),
    openai: Object.freeze({
        name: 'ChatGPT',
        storageKey: 'openai_api_key',
        color: '#6B21A8',
        model: 'gpt-4o',
        requiresKey: true,
    }),
});

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

// Keyless and free at the point of use, so it is the only sensible landing
// state for a first-time user. main.js migrates older stored selections
// ('apertus', 'publicai') onto this.
export const DEFAULT_PROVIDER = 'huggingface';

export function getProvider(id) {
    return PROVIDERS[id] ?? null;
}

export function modelFor(id) {
    return PROVIDERS[id]?.model ?? null;
}

// True when the provider cannot run without the user supplying a key. A
// provider with an *optional* key is not "missing" one — it falls back to the
// worker proxy — so this is deliberately narrower than "has no key".
export function needsApiKey(id, apiKey) {
    const provider = PROVIDERS[id];
    return Boolean(provider?.requiresKey) && !apiKey;
}
