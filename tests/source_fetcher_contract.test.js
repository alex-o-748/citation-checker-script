// Contract test for tf-source-fetcher (https://github.com/alex-o-748/tf-source-fetcher).
//
// Unlike tests/worker.test.js, which mocks globalThis.fetch with hand-shaped
// response objects to exercise fetchSourceContent()'s own parsing logic, this
// file spins up a *real* local HTTP server that implements tf-source-fetcher's
// documented API verbatim (query shape, response shapes, and the
// "Distinguishing refused from dead" status table — all copied from that
// repo's README as of 2026-08-11) and points fetchSourceContent() at it over
// real HTTP. The point is to catch drift between what that service's README
// promises and what this client actually parses, independent of either
// repo's own unit tests. If tf-source-fetcher's contract changes, update the
// fixture responses here to match its new README before assuming this client
// still works against it.
//
// service/run-extract.js's --live-source-fetch flag is the only caller
// of this contract in this repo today.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchSourceContent } from '../core/worker.js';

// Every failure case below makes fetchSourceContent() take its real Wayback
// fallback path (core/worker.js calls out to archive.org's availability API
// whenever the primary fetch returns no content). Left alone that would fire
// real network requests to archive.org on every test in this file — slow,
// flaky, and dependent on this sandbox's network policy for a test that has
// nothing to do with Wayback. Intercept only that one endpoint and report "no
// snapshot", exactly like tests/worker.test.js's
// "skips Wayback fallback when no snapshot exists" case; every other request
// (to the local fixture server below) goes over the real network stack
// unmodified, since real HTTP round-tripping to the fixture is the point of
// this file.
let realFetch;
beforeEach(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('archive.org/wayback/available')) {
            return Promise.resolve({
                ok: true,
                status: 200,
                json: async () => ({ archived_snapshots: {} }),
            });
        }
        return realFetch(input, init);
    };
});
afterEach(() => {
    globalThis.fetch = realFetch;
});

// Routes a request to a fixture response by a marker in the target URL
// (?fetch=...&page=...), mirroring the exact JSON shapes documented in
// tf-source-fetcher's README.
function startFixtureServer() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const target = url.searchParams.get('fetch') || '';
        const page = url.searchParams.get('page');

        const send = (httpStatus, body) => {
            const payload = JSON.stringify(body);
            res.writeHead(httpStatus, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(payload),
                'Access-Control-Allow-Origin': '*',
            });
            res.end(payload);
        };

        // README: "Response — success"
        if (target.includes('ok-page')) {
            return send(200, {
                content: 'y'.repeat(500),
                error: null,
                status: 200,
                pdf: false,
                totalPages: null,
                page: null,
                truncated: false,
                fetched_at: '2026-08-11T06:00:00.000Z',
                cached: false,
            });
        }

        // README: "Response — success" for a paginated PDF.
        if (target.includes('some.pdf')) {
            return send(200, {
                content: 'z'.repeat(500),
                error: null,
                status: 200,
                pdf: true,
                totalPages: 40,
                page: page ? Number(page) : null,
                truncated: false,
                fetched_at: '2026-08-11T06:00:00.000Z',
                cached: false,
            });
        }

        // README: "Response — no usable content" (JS-only shell / login wall;
        // fetched fine, extracted text was under 101 characters).
        if (target.includes('empty-shell')) {
            return send(200, {
                content: null,
                error: 'Source content was empty or too short to verify',
                status: 200,
            });
        }

        // README table: "Upstream returned a real HTTP status" — passed
        // through unchanged, both in the body and as this service's own
        // outer HTTP status.
        if (target.includes('404-page')) {
            return send(404, { content: null, error: 'Not Found', status: 404 });
        }

        // README table: "Blocked by the target host's robots.txt" — we never
        // contacted the host; status is our own considered 403.
        if (target.includes('robots-blocked')) {
            return send(403, { content: null, error: 'Blocked by robots.txt', status: 403 });
        }

        // README table: "Throttled by our own per-host rate limiter" — 429,
        // we never contacted the host this time.
        if (target.includes('rate-limited')) {
            return send(429, { content: null, error: 'Rate limited, try again shortly', status: 429 });
        }

        // README table: "Upstream unreachable (DNS failure, connection
        // refused, timeout)" — status: null in the body is the documented
        // signal for "we never got a response at all"; this service's own
        // outer HTTP status is 502.
        if (target.includes('unreachable-host')) {
            return send(502, { content: null, error: 'DNS lookup failed', status: null });
        }

        return send(400, { content: null, error: `fixture has no route for ${target}`, status: 400 });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                workerBase: `http://127.0.0.1:${port}`,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

test('fetchSourceContent parses a successful tf-source-fetcher response', async () => {
    const fixture = await startFixtureServer();
    try {
        const result = await fetchSourceContent('https://example.com/ok-page', null, { workerBase: fixture.workerBase });
        assert.equal(result.error, null);
        assert.equal(result.status, 200);
        assert.ok(result.content.includes('Source URL: https://example.com/ok-page'));
        assert.ok(result.content.includes('y'.repeat(500)));
    } finally {
        await fixture.close();
    }
});

test('fetchSourceContent surfaces PDF metadata from tf-source-fetcher', async () => {
    const fixture = await startFixtureServer();
    try {
        const result = await fetchSourceContent('https://example.com/some.pdf', 7, { workerBase: fixture.workerBase });
        assert.equal(result.status, 200);
        assert.ok(result.content.includes('PDF: 40 pages'));
        assert.ok(result.content.includes('(extracted page 7)'));
    } finally {
        await fixture.close();
    }
});

test('fetchSourceContent treats "no usable content" as unavailable, not an error state', async () => {
    const fixture = await startFixtureServer();
    try {
        const result = await fetchSourceContent('https://example.com/empty-shell', null, { workerBase: fixture.workerBase });
        assert.equal(result.content, null);
        assert.equal(result.status, 200);
        assert.match(result.error, /empty or too short/);
    } finally {
        await fixture.close();
    }
});

test('fetchSourceContent passes through a real upstream 404 unchanged', async () => {
    const fixture = await startFixtureServer();
    try {
        const result = await fetchSourceContent('https://example.com/404-page', null, { workerBase: fixture.workerBase });
        assert.equal(result.content, null);
        assert.equal(result.status, 404);
        assert.equal(result.error, 'Not Found');
    } finally {
        await fixture.close();
    }
});

test('fetchSourceContent reports a robots.txt block as status 403', async () => {
    const fixture = await startFixtureServer();
    try {
        const result = await fetchSourceContent('https://example.com/robots-blocked', null, { workerBase: fixture.workerBase });
        assert.equal(result.content, null);
        assert.equal(result.status, 403);
        assert.match(result.error, /robots\.txt/);
    } finally {
        await fixture.close();
    }
});

test('fetchSourceContent reports the service\'s own rate limit as status 429', async () => {
    const fixture = await startFixtureServer();
    try {
        const result = await fetchSourceContent('https://example.com/rate-limited', null, { workerBase: fixture.workerBase });
        assert.equal(result.content, null);
        assert.equal(result.status, 429);
    } finally {
        await fixture.close();
    }
});

// Documents a real subtlety in the contract: the README says body `status:
// null` means "we never got a response at all", and that this service's own
// outer HTTP status is 502 in that case. fetchSourceContent() only reads
// `data.status` and falls back to the proxy's own HTTP status when that
// field isn't a number (core/worker.js: `typeof data.status === 'number'`) —
// so an "unreachable host" from tf-source-fetcher surfaces to this client as
// status 502, not status null. null status is reserved for when this
// client's own request to tf-source-fetcher never got a response at all
// (see tests/worker.test.js's "network failures" case). Pinning this here so
// a future reader doesn't "fix" fetchSourceContent to pass through a literal
// null and silently change what every caller sees for this case.
test('fetchSourceContent surfaces tf-source-fetcher\'s "unreachable host" as status 502, not null', async () => {
    const fixture = await startFixtureServer();
    try {
        const result = await fetchSourceContent('https://example.com/unreachable-host', null, { workerBase: fixture.workerBase });
        assert.equal(result.content, null);
        assert.equal(result.status, 502);
    } finally {
        await fixture.close();
    }
});

test('fetchSourceContent never sends Google Books URLs to the fetcher at all', async () => {
    const fixture = await startFixtureServer();
    try {
        const result = await fetchSourceContent('https://books.google.com/books?id=abc', null, { workerBase: fixture.workerBase });
        assert.equal(result.content, null);
        assert.match(result.error, /google books/i);
    } finally {
        await fixture.close();
    }
});
