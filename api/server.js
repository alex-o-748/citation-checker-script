#!/usr/bin/env node

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { MAX_BODY_BYTES, verifyRequest } from './verify.js';
import { OPENAPI_DOCUMENT } from './openapi.js';

const WIKIPEDIA_ORIGIN = /^https:\/\/[a-z0-9-]+\.wikipedia\.org$/i;
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

function clientAddress(req) {
    // Do not trust X-Forwarded-For here. A deployment with a trusted reverse
    // proxy must replace this function at that boundary rather than letting a
    // caller choose its own rate-limit key.
    return req.socket.remoteAddress || 'unknown';
}

export function createRateLimiter({ limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS, now = Date.now } = {}) {
    const clients = new Map();
    return (key) => {
        const time = now();
        // Bound retained state when scanners continually rotate addresses.
        if (clients.size >= 10_000) {
            for (const [client, value] of clients) {
                if (value.resetAt <= time) clients.delete(client);
            }
            if (clients.size >= 10_000 && !clients.has(key)) {
                clients.delete(clients.keys().next().value);
            }
        }
        let entry = clients.get(key);
        if (!entry || entry.resetAt <= time) {
            entry = { count: 0, resetAt: time + windowMs };
            clients.set(key, entry);
        }
        entry.count += 1;
        return {
            allowed: entry.count <= limit,
            limit,
            remaining: Math.max(0, limit - entry.count),
            resetSeconds: Math.max(1, Math.ceil((entry.resetAt - time) / 1000)),
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

export function createVerifyServer({ verify = verifyRequest, rateLimit = createRateLimiter(), address = clientAddress } = {}) {
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

        const allowance = rateLimit(address(req));
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
