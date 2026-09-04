// Shared provider metadata for batch runners that call a model directly
// (service/run-replay.js, service/run-sweep.js): the default model per
// provider, and which environment variable holds its API key.
//
// Sourced from main.js's this.providers config, which is the authoritative,
// complete provider list (cli/verify.js's KNOWN_PROVIDERS now includes
// 'liftwing' too — see its --live-llm-router flag). Lift Wing, called from
// inside Toolforge, is the specific thing docs/design-plans/
// 2026-08-07-batch-source-checks-for-edit-suggestions.md §5 calls "the
// strongest single argument for Toolforge hosting" — a batch runner for a
// Toolforge migration that can't select it is missing its own point. Keep in
// sync with main.js's this.providers by hand if either changes.
export const PROVIDER_MODELS = {
    publicai:    'aisingapore/Qwen-SEA-LION-v4-32B-IT',
    huggingface: 'openai/gpt-oss-20b',
    liftwing:    'llm-qwen36-27b',
    claude:      'claude-sonnet-4-6',
    gemini:      'gemini-flash-latest',
    openai:      'gpt-4o',
};

export const PROVIDER_ENV_VARS = {
    publicai:    null,
    huggingface: null,
    liftwing:    null, // proxied through the CORS worker; no client-side key
    claude:      'CLAUDE_API_KEY',
    gemini:      'GEMINI_API_KEY',
    openai:      'OPENAI_API_KEY',
};
