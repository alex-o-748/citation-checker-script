# Verify-stage concurrency, landed — fetch concurrency, not yet

> **Status (2026-08-25):** Implemented and merged into `dev`: a bounded
> concurrency pool for `run-sweep.js`'s model calls (`--concurrency`), plus
> four correctness fixes it depended on being safe (see "What shipped"
> below). **Fetch-stage concurrency is proposed, not started** — this doc's
> second half is the instructions for building it, and the reason it isn't
> done yet is a real, unresolved safety question, not lack of time. Numbers
> below are from real runs against `tf-llm-router` and `tf-source-fetcher`
> on 2026-08-24/25, not synthetic benchmarks.

## Why this started

The maintainer's target is 1000 articles × ~100 checks each. The original
batch pipeline (`service/run-sweep.js`) ran every model call serially with a
fixed 1s delay between them — no concurrency anywhere. At that rate, 100,000
calls was days, before any fetch cost was even counted.

## What shipped

Six PRs' worth of work landed on this branch, each one surfaced by trying to
actually run the thing, not by inspection:

1. **Halt on any unrecoverable error, not just auth/billing** — previously
   only `ProviderAuthError` (401/402/403) was caught around the model call;
   any other error (a retry-exhausted 429, a network blip) propagated
   uncaught and crashed the process *before* the CSV write at the end of
   `runSweep()` ran, silently discarding every finding computed so far.
   `service/run-sweep.js`, exit code 4 for this class, distinct from auth's
   exit code 3.

2. **`--live-llm-router`** — `--provider liftwing` was silently going through
   the Cloudflare Worker's shared approved-bot-JWT path (the same one the
   live userscript uses), not `tf-llm-router` (Lift Wing reached directly
   from inside Toolforge — the actual subject of the parent design doc's §5
   Toolforge-migration argument). The two turned out to have very different
   rate-limit behavior: the worker path 429'd after 2 back-to-back calls at
   `--delay-ms 0`; `tf-llm-router` took 100 back-to-back calls with zero
   errors. `service/run-sweep.js`, `service/run-replay.js`.

3. **The concurrency pool itself** — a single producer coroutine drives
   `runBatch()` (fetch stays serial, see below) and yields one task per solo
   citation or group; `--concurrency` worker coroutines pull from that same
   async generator concurrently. Verified pattern: concurrent `.next()`
   calls on one async generator queue and resolve in order — no hand-rolled
   queue class. Halt semantics are preserved under concurrency, not
   weakened: a fatal error stops new dispatch immediately but lets
   already-in-flight calls finish and record; the producer also stops
   fetching further articles once halted, which needed driving `runBatch`'s
   iterator by hand instead of `for await...of` (the latter fetches its next
   value *before* running the loop body, which would let one extra article
   slip through a naive halt check). Default `--concurrency 1` — opt-in,
   backward compatible. `service/run-sweep.js`.

4. **Retry undici's generic `"fetch failed"`** — Node's `fetch` throws this
   exact top-level message for every network/transport failure (DNS,
   connection reset, TLS); the real reason lives in `error.cause`, which
   `core/retry.js`'s `isRetryableError()` never inspected. This entire class
   of transient failures skipped retry and went straight to a hard failure.
   Reproduced live: a `--delay-ms 0` run against the worker path failed this
   way on the 4th call. Now retried like any other network error.

5. **Context-length-exceeded → per-citation `ERROR`, not a run halt** — a
   prompt exceeding the model's context window (vLLM's `"maximum context
   length"` validation error, reported as an HTTP 500) is data-dependent and
   permanent for *that one citation's source* — unlike auth failure, it says
   nothing about any other citation. It was retried 5 times anyway (500
   matches `RETRYABLE_STATUS`) then halted the whole sweep. Now excluded
   from retry (`core/retry.js`'s `isContextLengthError()`) and
   `verifyCitation()`/`verifyGroup()` return a normal `verdict: 'ERROR'`
   result instead of throwing — the same non-throwing shape as the existing
   `SOURCE UNAVAILABLE` short-circuit, so `run-sweep.js` needed zero control-flow
   changes. `service/verifier.js`.

6. **Timing + retry visibility in the summary output** — `run-sweep.js`
   previously printed nothing until the whole run finished. Now reports
   fetch wall-clock time, verify call count/sum/min/max, and retry
   attempts/backoff time separately from genuine model latency — built
   specifically to answer "is fetch or verify the bottleneck" and "is a slow
   average hidden retries or real latency" with data instead of inference.
   `service/run-sweep.js`.

`scripts/probe-concurrency.js` — a throwaway diagnostic, not part of the
pipeline — fires N concurrent calls at `tf-llm-router` per concurrency level
and reports throughput/errors. Used to find the concurrency ceiling before
building anything permanent.

## What was measured

**Concurrency ceiling for `tf-llm-router`** (`probe-concurrency.js`, 100 calls/level,
dataset.json rows): throughput scaled through concurrency 32 (~2.18 calls/s
peak) then flattened/regressed at 64. This number is a courtesy ceiling for
*that backend at that moment* — see the caveat below.

**Verify latency, from real sweeps** (`--live-source-fetch --live-llm-router
--concurrency 32`, single-article runs): once separated from short-circuited/
skipped tasks and from retry backoff (both now visible in the summary
output), real per-call latency settled at **~9-12.5s/call** across four
separate runs on two different articles. One early outlier (~44.6s/call)
measured immediately after a ~70-minute, 5-article, concurrency-32 sweep is
best explained as residual backend queue backlog from that prior sustained
load, not a property of verify itself — later runs, once the backend had
caught up, were consistent with the probe's original estimate.

**Retries are not the driver of verify latency.** Explicit backoff time,
measured directly rather than inferred: 0.000s, 2.7s, 5.4s across three
runs — real but under 1% of total verify time each time.

**Fetch dominates, and is far more variable than verify.** Two different
articles, both cold (first time fetching their sources): 233.8s (67% of a
349.6s total) and 512.8s (94% of a 543.1s total). A caching-looking
speedup seen when *repeating the same article* (233.8s → 82.2s → 70.3s →
53.7s across four runs) turned out to be exactly that — an artifact of
re-fetching identical, now-cached URLs. It does not generalize: a genuinely
different article showed no such benefit and was worse than either cold
baseline. Fetching stays fully serial in this pipeline; nothing built this
session parallelizes it.

**The two systems' timing moved together in a way neither alone explains.**
Across two runs of the same article, both fetch *and* verify got faster by a
similar factor (~2.8-3.5x) at the same time, despite hitting completely
separate backends (`tf-source-fetcher` vs. `tf-llm-router`). Leading
hypothesis: shared infrastructure the calling process itself sits on
(Toolforge pod/network contention), not either target service specifically.
Not confirmed — would need fetch-only and verify-only runs spaced apart in
time to isolate.

## The 1000-article estimate, honestly

Per-citation cost from what's measured: verify is well-characterized
(~9-12.5s/real-call, stable across articles) but fetch is not (233.8s-512.8s
observed cold, for 88-197 citations respectively — no stable per-citation
rate yet). Citations-per-article is *also* highly variable: 88, 197, and
233.6 (average across an earlier 5-article sample) are the three data points
in hand, plus a single article observed elsewhere with 720. Multiplying
these uncertainties together gives a plausible range spanning roughly
**1.5-9 days** for 1000 articles — too wide to plan against. The dominant
unknowns are both on the fetch side: per-article fetch cost, and
citations-per-article. **Verify's number is trustworthy enough to stop
re-measuring it for now.**

Narrowing this needs a real sample, not another single-article test: `--max
10` or `--max 20` against fresh (not-repeated) articles, to get an honest
citations-per-article average and a fetch number unaffected by same-article
caching artifacts.

## Fetch concurrency: what's actually blocking it

**This is not the automatic next step just because fetch measured as the
larger cost.** Two open problems, not one:

### 1. Verify's own slowness isn't fully explained yet

The "shared infrastructure" hypothesis above is unconfirmed. Building fetch
concurrency without knowing whether verify's latency swings are caused by
our own calling environment (which fetch concurrency would make *worse*, by
adding more concurrent outbound work from the same pod) versus something
external would be building on an unverified assumption.

### 2. Fetch concurrency is a materially different, harder problem than verify concurrency was

Verify concurrency meant negotiating with one backend (`tf-llm-router`) we
have some visibility into and could safety-test with
`probe-concurrency.js`. Fetch concurrency means firing parallel requests at
**hundreds of different third-party websites**, each with its own tolerance,
`robots.txt`, and rate limits. The parent design doc
(`2026-08-07-batch-source-checks-for-edit-suggestions.md`, §5) is explicit
this is a reputational concern for the Foundation, not just a technical one:

> Concentrating what is currently thousands of editors' individual fetches
> onto Wikimedia IP space, unattended and at volume, is a reputational
> exposure for WMF (publishers blocking Wikimedia ranges) as much as a
> technical one.

There is currently **no equivalent of `probe-concurrency.js` for fetch** —
no data on what concurrency level is safe against real, diverse external
sites. Building it blind repeats the exact mistake this session corrected
for verify (guessed at a number, found out the hard way via a live 429)
except against external infrastructure we don't control and can't easily
recover a reputation with if it goes wrong.

## Instructions for building fetch concurrency, when it's time

1. **Don't start here without a decision from the maintainer on the WMCS
   question first.** `--live-source-fetch` for a small, attended,
   manual run needs no clearance (§G3 of the 2026-08-24 doc settles this);
   *unattended, production-volume* fetching from Toolforge is the part still
   gated on WMCS (`docs/design-plans/2026-08-07-...md`, open question 1).
   Concurrent fetching at 1000-article volume is squarely that second case.

2. **Build a fetch-side equivalent of `probe-concurrency.js` before touching
   `run-sweep.js`'s fetch stage.** It needs to differ from the verify probe
   in one essential way: it must respect `robots.txt` and per-host rate
   limits *by construction*, not just measure raw throughput — a probe that
   found "64 concurrent fetches work great" by hammering the same few test
   domains would be exactly the wrong lesson. Group by host and cap
   concurrency *per host*, not just globally, mirroring
   `benchmark/run_benchmark.js`'s `hostForProvider`-based host grouping
   (used there because "tasks sharing a hostname share one concurrency
   budget, since they share an upstream rate-limit boundary" — the same
   logic applies here, with the added constraint that these are third-party
   sites we don't control at all, unlike a benchmark provider endpoint).

3. **Distinguish "dead link" from "we were refused."** The parent design doc
   already flags this: `fetchSourceContent()` returns `status`, but nothing
   downstream currently treats 403/429 as *retry later, and back off harder*
   rather than a permanent failure indistinguishable from a 404. Adding
   concurrency without this makes the failure mode worse, not just
   unmeasured — more concurrent requests means more simultaneous 429s
   against sites that are telling us to slow down.

4. **Measure the "shared infrastructure" question first if possible** — run
   fetch-only (`run-extract.js --live-source-fetch`) and verify-only
   (`run-replay.js --live-llm-router`) in isolation, spaced apart in time, to
   see if their latencies still move together when *not* sharing a process.
   If they do, the bottleneck is likely on the Toolforge/network side and
   fetch concurrency should be sized more conservatively than raw throughput
   numbers would suggest, since it's adding load to whatever that shared
   resource is.

5. **Only after 1-4**, extend `service/run-sweep.js`'s existing
   producer/worker-pool pattern (already built for verify — see
   `generateTasks()`/`worker()`) to the fetch stage, keeping the per-host cap
   from step 2 as a hard constraint, not a tunable default.
