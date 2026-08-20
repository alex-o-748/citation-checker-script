// Contract test for tf-llm-router (https://github.com/alex-o-748/tf-llm-router).
//
// Unlike tests/providers.test.js, which mocks globalThis.fetch with
// hand-shaped response objects to exercise callHuggingFaceAPI() /
// callLiftwingAPI()'s own parsing logic, this file spins up a *real* local
// HTTP server that implements tf-llm-router's documented API verbatim
// (routes, request/response shapes, and the error-status table — all copied
// from that repo's README as of 2026-08-10) and points the client at it over
// real HTTP. The point is to catch drift between what that service's README
// promises and what this client actually sends/parses, independent of
// either repo's own unit tests. If tf-llm-router's contract changes, update
// the fixture responses here to match its new README before assuming this
// client still works against it.
//
// ccs verify's --live-llm-router flag is the only caller of this contract in
// this repo today.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { callHuggingFaceAPI, callLiftwingAPI } from '../core/providers.js';

// Routes a request by a marker in the request body's `model` field, mirroring
// the exact shapes and status codes documented in tf-llm-router's README.
function startFixtureServer() {
    const requests = [];

    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            requests.push({ method: req.method, path: req.url, headers: req.headers, body });

            const send = (httpStatus, json) => {
                const payload = JSON.stringify(json);
                res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
                res.end(payload);
            };

            if (req.method !== 'POST') {
                return send(405, { error: { message: 'Method not allowed' } });
            }
            if (req.url !== '/hf' && req.url !== '/liftwing') {
                return send(404, { error: { message: 'Unknown route' } });
            }

            let parsed;
            try {
                parsed = JSON.parse(body);
            } catch {
                return send(400, { error: { message: 'Malformed JSON' } });
            }

            // README: "Response" — a normal completion.
            if (parsed.model === 'llm-ok') {
                return send(200, {
                    choices: [{ message: { content: 'verdict text' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 120, completion_tokens: 30 },
                });
            }

            // README: "finish_reason: 'length' with empty content is passed
            // through faithfully" — the model ran out of budget reasoning.
            if (parsed.model === 'llm-truncated') {
                return send(200, {
                    choices: [{ message: { content: '' }, finish_reason: 'length' }],
                    usage: { prompt_tokens: 120, completion_tokens: parsed.max_tokens },
                });
            }

            // README error table: "Malformed JSON / model not allowlisted" -> 400.
            if (parsed.model === 'llm-not-allowlisted') {
                return send(400, { error: { message: 'model not in allowlist' } });
            }

            // README error table: "Local rate limit (if enabled)" -> 429.
            if (parsed.model === 'llm-rate-limited') {
                res.setHeader('Retry-After', '5');
                return send(429, { error: { message: 'rate limit exceeded' } });
            }

            // README error table: "Upstream 401/403" -> mapped to 502, upstream
            // detail preserved in the message (never passed through as-is,
            // since it's our credential that was rejected, not the caller's).
            if (parsed.model === 'llm-upstream-auth-fail') {
                return send(502, { error: { message: 'upstream rejected credentials (401): invalid token' } });
            }

            // README error table: "Any other upstream status" -> passed
            // through verbatim.
            if (parsed.model === 'llm-upstream-503') {
                return send(503, { error: { message: 'upstream temporarily unavailable' } });
            }

            // README error table: "Body over the size cap" -> 413.
            if (parsed.model === 'llm-body-too-large') {
                return send(413, { error: { message: 'request body too large' } });
            }

            return send(400, { error: { message: `fixture has no route for model ${parsed.model}` } });
        });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                workerBase: `http://127.0.0.1:${port}`,
                requests,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

test('callHuggingFaceAPI posts the documented request shape to /hf', async () => {
    const fixture = await startFixtureServer();
    try {
        await callHuggingFaceAPI({
            model: 'llm-ok',
            systemPrompt: 'sys',
            userContent: 'user',
            workerBase: fixture.workerBase,
        });
        assert.equal(fixture.requests.length, 1);
        const req = fixture.requests[0];
        assert.equal(req.method, 'POST');
        assert.equal(req.path, '/hf');
        assert.equal(req.headers['content-type'], 'application/json');
        // README: "No Authorization header — the service injects any
        // credential the upstream needs" when the client has no apiKey.
        assert.equal(req.headers['authorization'], undefined);
        const sent = JSON.parse(req.body);
        assert.equal(sent.model, 'llm-ok');
        assert.deepEqual(sent.messages, [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'user' },
        ]);
        assert.equal(typeof sent.max_tokens, 'number');
    } finally {
        await fixture.close();
    }
});

test('callLiftwingAPI posts the documented request shape to /liftwing', async () => {
    const fixture = await startFixtureServer();
    try {
        const result = await callLiftwingAPI({
            model: 'llm-ok',
            systemPrompt: 'sys',
            userContent: 'user',
            workerBase: fixture.workerBase,
        });
        assert.equal(result.text, 'verdict text');
        assert.equal(result.usage.input, 120);
        assert.equal(result.usage.output, 30);
        assert.equal(fixture.requests[0].path, '/liftwing');
    } finally {
        await fixture.close();
    }
});

test('callHuggingFaceAPI reports the "ran out of output budget" case for finish_reason length', async () => {
    const fixture = await startFixtureServer();
    try {
        await assert.rejects(
            () => callHuggingFaceAPI({
                model: 'llm-truncated',
                systemPrompt: 'sys',
                userContent: 'user',
                workerBase: fixture.workerBase,
                maxTokens: 999,
            }),
            /ran out of output budget/
        );
    } finally {
        await fixture.close();
    }
});

test('callHuggingFaceAPI surfaces a 400 model-not-allowlisted error', async () => {
    const fixture = await startFixtureServer();
    try {
        await assert.rejects(
            () => callHuggingFaceAPI({ model: 'llm-not-allowlisted', systemPrompt: 'sys', userContent: 'user', workerBase: fixture.workerBase }),
            /HuggingFace API request failed \(400\).*not in allowlist/
        );
    } finally {
        await fixture.close();
    }
});

test('callHuggingFaceAPI surfaces the local 429 rate limit', async () => {
    const fixture = await startFixtureServer();
    try {
        await assert.rejects(
            () => callHuggingFaceAPI({ model: 'llm-rate-limited', systemPrompt: 'sys', userContent: 'user', workerBase: fixture.workerBase }),
            /API request failed \(429\)/
        );
    } finally {
        await fixture.close();
    }
});

// README: upstream 401/403 is deliberately remapped to 502 by tf-llm-router
// itself (never passed through as 401/403), because that status describes
// its own rejected credential, not the caller's. The client doesn't need to
// know that remapping happened — it just needs to handle 502 like any other
// 5xx — but pinning it here means a future change that accidentally passes
// 401/403 straight through would show up as a client-side test failure too,
// not just a server-side one.
test('callHuggingFaceAPI surfaces tf-llm-router\'s 502-remapped upstream auth failure', async () => {
    const fixture = await startFixtureServer();
    try {
        await assert.rejects(
            () => callHuggingFaceAPI({ model: 'llm-upstream-auth-fail', systemPrompt: 'sys', userContent: 'user', workerBase: fixture.workerBase }),
            /API request failed \(502\)/
        );
    } finally {
        await fixture.close();
    }
});

test('callHuggingFaceAPI passes through an unrelated upstream 503 verbatim', async () => {
    const fixture = await startFixtureServer();
    try {
        await assert.rejects(
            () => callHuggingFaceAPI({ model: 'llm-upstream-503', systemPrompt: 'sys', userContent: 'user', workerBase: fixture.workerBase }),
            /API request failed \(503\)/
        );
    } finally {
        await fixture.close();
    }
});

test('callHuggingFaceAPI gives the size-cap-specific message on a 413', async () => {
    const fixture = await startFixtureServer();
    try {
        await assert.rejects(
            () => callHuggingFaceAPI({ model: 'llm-body-too-large', systemPrompt: 'sys', userContent: 'user', workerBase: fixture.workerBase }),
            /the source is too large to send/
        );
    } finally {
        await fixture.close();
    }
});
