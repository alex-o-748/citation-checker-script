// In-memory request metrics for the Verify API's monitoring board.
//
// Deliberately small: counters and a ring of recent events in the server
// process, no database and no external collector. It resets on restart, and
// the board says so by showing when the process started. What it never keeps
// is request content — no claim text, no source text, no full URL, only the
// source's hostname — because the board is as public as the endpoint.

export const OUTCOMES = Object.freeze({
    OK: 'ok',
    SOURCE_UNAVAILABLE: 'source_unavailable',
    UPSTREAM_ERROR: 'upstream_error',
    RATE_LIMITED: 'rate_limited',
    REJECTED: 'rejected',
});
export const OUTCOME_LIST = Object.freeze(Object.values(OUTCOMES));

const MINUTE_MS = 60_000;
const RETAIN_MINUTES = 24 * 60;
const HEALTH_WINDOW_MINUTES = 15;
// A 502 share above this over the health window marks the service degraded.
const DEGRADED_ERROR_SHARE = 0.25;

export function outcomeFor(status) {
    if (status >= 200 && status < 300) return OUTCOMES.OK;
    if (status === 422) return OUTCOMES.SOURCE_UNAVAILABLE;
    if (status === 429) return OUTCOMES.RATE_LIMITED;
    if (status >= 500) return OUTCOMES.UPSTREAM_ERROR;
    return OUTCOMES.REJECTED;
}

function emptyCounts() {
    const outcomes = Object.fromEntries(OUTCOME_LIST.map(o => [o, 0]));
    return { requests: 0, outcomes, verdicts: {}, stages: {}, sources: {}, durationSum: 0, durationCount: 0 };
}

function addTo(counts, event) {
    counts.requests += 1;
    counts.outcomes[event.outcome] += 1;
    if (event.verdict) counts.verdicts[event.verdict] = (counts.verdicts[event.verdict] || 0) + 1;
    if (event.stage) counts.stages[event.stage] = (counts.stages[event.stage] || 0) + 1;
    if (event.source) counts.sources[event.source] = (counts.sources[event.source] || 0) + 1;
    // Only requests that reached the pipeline say anything about its speed; a
    // 429 or a 400 returns in microseconds and would flatter every percentile.
    if (event.reachedPipeline) {
        counts.durationSum += event.durationMs;
        counts.durationCount += 1;
    }
}

function mergeInto(target, counts) {
    target.requests += counts.requests;
    for (const [k, v] of Object.entries(counts.outcomes)) target.outcomes[k] += v;
    for (const key of ['verdicts', 'stages', 'sources']) {
        for (const [k, v] of Object.entries(counts[key])) target[key][k] = (target[key][k] || 0) + v;
    }
    target.durationSum += counts.durationSum;
    target.durationCount += counts.durationCount;
}

function percentile(sorted, p) {
    if (!sorted.length) return null;
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return Math.round(sorted[Math.max(0, index)]);
}

function latencySummary(durations) {
    const sorted = [...durations].sort((a, b) => a - b);
    return {
        n: sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        max: sorted.length ? Math.round(sorted[sorted.length - 1]) : null,
    };
}

/** Classify a request body by which source field it used, without keeping either. */
export function describeSource(body) {
    if (!body || typeof body !== 'object') return { source: null, sourceHost: null };
    if (typeof body.source_content === 'string' && body.source_content.trim()) {
        return { source: 'content', sourceHost: null };
    }
    if (typeof body.source_url === 'string' && body.source_url.trim()) {
        let sourceHost = null;
        try { sourceHost = new URL(body.source_url).hostname || null; } catch { /* invalid URL: a 400 */ }
        return { source: 'url', sourceHost };
    }
    return { source: null, sourceHost: null };
}

export function createMetrics({ now = Date.now, recentLimit = 50, latencyLimit = 5000 } = {}) {
    const startedAt = now();
    const totals = emptyCounts();
    const minutes = new Map(); // minute index -> counts
    const latencies = []; // { at, ms } for requests that reached the pipeline
    const recent = [];
    let lastSuccessAt = null;
    let lastFailure = null;

    function prune(currentMinute) {
        for (const minute of minutes.keys()) {
            if (minute <= currentMinute - RETAIN_MINUTES) minutes.delete(minute);
        }
    }

    function record({ status, body = null, durationMs = 0, source = null, sourceHost = null }) {
        const at = now();
        const outcome = outcomeFor(status);
        const event = {
            at,
            status,
            outcome,
            verdict: status === 200 ? body?.verdict ?? null : null,
            stage: body?.stage ?? null,
            source,
            sourceHost,
            durationMs: Math.max(0, durationMs),
            reachedPipeline: outcome === OUTCOMES.OK
                || outcome === OUTCOMES.SOURCE_UNAVAILABLE
                || outcome === OUTCOMES.UPSTREAM_ERROR,
        };

        addTo(totals, event);
        const minute = Math.floor(at / MINUTE_MS);
        if (!minutes.has(minute)) {
            minutes.set(minute, emptyCounts());
            prune(minute);
        }
        addTo(minutes.get(minute), event);

        if (event.reachedPipeline) {
            latencies.push({ at, ms: event.durationMs });
            if (latencies.length > latencyLimit) latencies.shift();
        }
        if (outcome === OUTCOMES.OK) lastSuccessAt = at;
        if (outcome === OUTCOMES.UPSTREAM_ERROR || outcome === OUTCOMES.SOURCE_UNAVAILABLE) {
            lastFailure = { at, status, stage: event.stage, error: body?.error ?? null };
        }

        recent.unshift({
            at: new Date(at).toISOString(),
            status,
            outcome,
            verdict: event.verdict,
            stage: event.stage,
            source,
            source_host: sourceHost,
            duration_ms: Math.round(event.durationMs),
        });
        if (recent.length > recentLimit) recent.pop();
    }

    function windowCounts(currentMinute, spanMinutes) {
        const counts = emptyCounts();
        for (let m = currentMinute - spanMinutes + 1; m <= currentMinute; m++) {
            const bucket = minutes.get(m);
            if (bucket) mergeInto(counts, bucket);
        }
        return counts;
    }

    function summarize(counts, sinceMs) {
        const durations = latencies.filter(l => l.at >= sinceMs).map(l => l.ms);
        return {
            requests: counts.requests,
            outcomes: counts.outcomes,
            verdicts: counts.verdicts,
            failed_stages: counts.stages,
            sources: counts.sources,
            latency_ms: latencySummary(durations),
        };
    }

    function series(currentMinute, points, stepMinutes) {
        const out = [];
        for (let i = points - 1; i >= 0; i--) {
            const end = currentMinute - i * stepMinutes;
            const counts = windowCounts(end, stepMinutes);
            out.push({
                start: new Date((end - stepMinutes + 1) * MINUTE_MS).toISOString(),
                requests: counts.requests,
                outcomes: counts.outcomes,
                avg_latency_ms: counts.durationCount ? Math.round(counts.durationSum / counts.durationCount) : null,
            });
        }
        return out;
    }

    function health(currentMinute) {
        const counts = windowCounts(currentMinute, HEALTH_WINDOW_MINUTES);
        const attempted = counts.requests - counts.outcomes[OUTCOMES.REJECTED] - counts.outcomes[OUTCOMES.RATE_LIMITED];
        const errors = counts.outcomes[OUTCOMES.UPSTREAM_ERROR];
        if (attempted === 0) {
            return { state: 'idle', window_minutes: HEALTH_WINDOW_MINUTES, error_share: null };
        }
        const share = errors / attempted;
        return {
            state: share > DEGRADED_ERROR_SHARE ? 'degraded' : 'ok',
            window_minutes: HEALTH_WINDOW_MINUTES,
            error_share: Math.round(share * 1000) / 1000,
        };
    }

    function snapshot({ rateLimit = null, service = {} } = {}) {
        const time = now();
        const currentMinute = Math.floor(time / MINUTE_MS);
        const minutesAgo = n => (currentMinute - n + 1) * MINUTE_MS;
        return {
            generated_at: new Date(time).toISOString(),
            service: {
                ...service,
                started_at: new Date(startedAt).toISOString(),
                uptime_seconds: Math.floor((time - startedAt) / 1000),
            },
            health: health(currentMinute),
            rate_limit: rateLimit,
            last_success_at: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : null,
            last_failure: lastFailure ? { ...lastFailure, at: new Date(lastFailure.at).toISOString() } : null,
            windows: {
                '15m': summarize(windowCounts(currentMinute, 15), minutesAgo(15)),
                '1h': summarize(windowCounts(currentMinute, 60), minutesAgo(60)),
                '24h': summarize(windowCounts(currentMinute, RETAIN_MINUTES), minutesAgo(RETAIN_MINUTES)),
                since_start: summarize(totals, startedAt),
            },
            series: {
                per_minute_1h: series(currentMinute, 60, 1),
                per_15_minutes_24h: series(currentMinute, 96, 15),
            },
            recent,
        };
    }

    return { record, snapshot };
}
