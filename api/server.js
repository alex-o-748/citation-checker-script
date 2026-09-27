#!/usr/bin/env node

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { MAX_BODY_BYTES, verifyRequest } from './verify.js';
import { OPENAPI_DOCUMENT } from './openapi.js';

const WIKIPEDIA_ORIGIN = /^https:\/\/[a-z0-9-]+\.wikipedia\.org$/i;

// One budget shared by every caller, not one per client. Toolforge's front
// proxy deliberately hides client addresses from tools and sends no
// X-Forwarded-For (https://phabricator.wikimedia.org/T228500), so every
// request arrives from the proxy and there is no per-client key to limit on.
// The budget protects tf-llm-router, which the batch sweeps also call:
// 30/minute is 0.5 calls/s, under a quarter of the ~2.2 calls/s peak measured
// in docs/design-plans/2026-08-25-verify-concurrency-and-the-fetch-question.md.
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

export function createRateLimiter({ limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS, now = Date.now } = {}) {
    let count = 0;
    let resetAt = 0;
    return () => {
        const time = now();
        if (resetAt <= time) {
            count = 0;
            resetAt = time + windowMs;
        }
        count += 1;
        return {
            allowed: count <= limit,
            limit,
            remaining: Math.max(0, limit - count),
            resetSeconds: Math.max(1, Math.ceil((resetAt - time) / 1000)),
        };
    };
}

function corsHeaders(req) {
    const origin = req.headers.origin;
    return origin && WIKIPEDIA_ORIGIN.test(origin)
        ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' }
        : {};
}

function sendJson(res, status, body, headers = {}) {
    const json = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(json),
        ...headers,
    });
    res.end(json);
}

async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            const error = new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
            error.status = 413;
            throw error;
        }
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        const error = new Error('Request body must be valid JSON');
        error.status = 400;
        throw error;
    }
}

export function createVerifyServer({ verify = verifyRequest, rateLimit = createRateLimiter() } = {}) {
    return createServer(async (req, res) => {
        const cors = corsHeaders(req);
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (req.method === 'GET' && pathname === '/') {
            return sendJson(res, 200, {
                name: OPENAPI_DOCUMENT.info.title,
                documentation: '/openapi.json',
                verify: '/v1/verify',
            }, cors);
        }
        if (req.method === 'GET' && pathname === '/openapi.json') {
            return sendJson(res, 200, OPENAPI_DOCUMENT, cors);
        }
        if (req.method === 'OPTIONS' && pathname === '/v1/verify') {
            res.writeHead(204, {
                ...cors,
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Max-Age': '86400',
            });
            return res.end();
        }
        if (req.method !== 'POST' || pathname !== '/v1/verify') {
            return sendJson(res, 404, { error: 'Not found' }, cors);
        }

        const mediaType = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
        if (mediaType !== 'application/json') {
            return sendJson(res, 415, { error: 'Content-Type must be application/json' }, cors);
        }

        const allowance = rateLimit();
        const rateHeaders = {
            'RateLimit-Limit': String(allowance.limit),
            'RateLimit-Remaining': String(allowance.remaining),
            'RateLimit-Reset': String(allowance.resetSeconds),
        };
        if (!allowance.allowed) {
            return sendJson(res, 429, { error: 'Rate limit exceeded' }, {
                ...cors, ...rateHeaders, 'Retry-After': String(allowance.resetSeconds),
            });
        }

        try {
            const body = await readJson(req);
            const result = await verify(body);
            return sendJson(res, result.status, result.body, { ...cors, ...rateHeaders });
        } catch (error) {
            const status = error.status || 500;
            const message = status === 500 ? 'Internal server error' : error.message;
            return sendJson(res, status, { error: message }, { ...cors, ...rateHeaders });
        }
    });
}

export function startServer({ port = Number(process.env.PORT) || 8080 } = {}) {
    const server = createVerifyServer();
    server.listen(port, () => {
        console.log(`Citation verification API listening on port ${port}`);
    });
    return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    startServer();
}
