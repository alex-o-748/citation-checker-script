// Concurrent source fetching for the batch pipeline, without ever putting two
// requests in flight to one host.
//
// Fetching used to be fully serial: one citation at a time, ~2.2s each, so a
// 238-article batch spent 6.7 hours in stage 3 with the network idle almost
// all of that time. Almost every citation in an article points at a different
// publisher, so the wait was never politeness — just one connection at a time.
//
// The constraint docs/design-plans/2026-08-25-verify-concurrency-and-the-fetch-
// question.md set for doing this is the one these two pieces enforce: a cap
// *per host*, as a hard property rather than a tunable. Each publisher sees at
// most one request from a sweep at a time — the same exposure the serial loop
// gave it. Only the number of *different* publishers in flight goes up.
//
// Two pieces, because the host a citation names is not the only host it
// touches:
//
//   runHostPool()  schedules citations: up to `concurrency` at once, never two
//                  whose URLs share a host, skipping ahead in the queue rather
//                  than parking a slot behind a busy host.
//   createHostGate() is passed into core/worker.js's fetchSourceContent as
//                  `hostGate`, and wraps each request it actually makes. That
//                  is what catches the convergence the pool cannot see: every
//                  dead link's fallback goes to archive.org and then
//                  web.archive.org, whatever host the citation named.
//
// tf-source-fetcher additionally paces each host at one request per second on
// its own side (src/rateLimiter.js), so this is a second, client-side layer,
// not the only one.

// The runners' default for --fetch-concurrency: how many *different* hosts a
// sweep fetches from at once. Deliberately modest. The per-host cap protects
// publishers whatever this is, so the number is about our own side: every
// request lands on the one tf-source-fetcher pod, whose heap ceiling is what
// crash-looped it in September (its README, "Memory"). HTML extraction there
// is synchronous, so concurrent requests do not stack extraction peaks, but
// downloaded bodies and PDF parses do overlap. Raise it while watching that
// pod's GET /metrics, not blind.
export const DEFAULT_FETCH_CONCURRENCY = 4;

/** The key both pieces group by: the URL's host (with port), lowercased. */
export function hostOf(url) {
    try {
        return new URL(url).host;
    } catch (_) {
        return String(url);
    }
}

/**
 * A per-host mutex: `gate(host, fn)` runs `fn` once fewer than `perHost`
 * calls for that host are running, in arrival order, and resolves with its
 * result. Idle hosts are dropped, so the map holds only hosts with work.
 */
export function createHostGate({ perHost = 1 } = {}) {
    const hosts = new Map(); // host -> { active, waiters: [resolve] }

    return async function gate(host, fn) {
        let state = hosts.get(host);
        if (!state) {
            state = { active: 0, waiters: [] };
            hosts.set(host, state);
        }
        if (state.active < perHost) {
            state.active++;
        } else {
            // The slot is handed over directly on release (below), so
            // `active` already counts this call when it wakes.
            await new Promise(resolve => state.waiters.push(resolve));
        }
        try {
            return await fn();
        } finally {
            const next = state.waiters.shift();
            if (next) {
                next();
            } else if (--state.active === 0) {
                hosts.delete(host);
            }
        }
    };
}

/**
 * Runs `run(job)` for every job, at most `concurrency` at once and at most one
 * per `keyOf(job)` at once. Picks the first queued job whose key is idle, so a
 * run of citations to one publisher waits its turn without holding up the
 * citations behind it. Resolves when every started job has settled.
 *
 * With `signal` aborted, no new job starts; jobs already running finish. A
 * job that throws is the caller's to record — `run` should catch its own
 * failures — but a throw here never stalls the pool.
 */
export function runHostPool(jobs, run, { concurrency = 1, keyOf, signal } = {}) {
    const queue = [...jobs];
    const busy = new Set();
    let active = 0;

    return new Promise(resolve => {
        const pump = () => {
            while (active < concurrency && queue.length > 0 && !signal?.aborted) {
                const index = queue.findIndex(job => !busy.has(keyOf(job)));
                if (index === -1) break; // every queued host is busy: wait for one to free up
                const [job] = queue.splice(index, 1);
                const key = keyOf(job);
                busy.add(key);
                active++;
                Promise.resolve()
                    .then(() => run(job))
                    .catch(() => {})
                    .finally(() => {
                        busy.delete(key);
                        active--;
                        pump();
                    });
            }
            if (active === 0) resolve();
        };
        pump();
    });
}
