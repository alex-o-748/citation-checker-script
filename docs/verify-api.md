# Verify API

The Verify API checks **one claim against one source**. It is a thin HTTP
entry point to `core/pipeline.js`; it uses the same source fetch, prompt, model
call, verdict parser, and quote verification as existing core consumers.

> **Deployment status (2026-09-15): not public yet.** This repository does not
> contain credentials or deployment access for either candidate production
> host. The paths below are final, but a public base URL must not be advertised
> until the maintainer confirms the host and deploys it. Run locally with
> `npm start` (default: `http://localhost:8080`).

## Check that it works

From a clone of this repository, install dependencies and start the server:

```sh
npm install
npm start
```

Leave that terminal running. In a second terminal, first check the HTTP server
without spending an inference call:

```sh
curl --fail-with-body http://localhost:8080/
curl --fail-with-body http://localhost:8080/openapi.json
```

The first command should return an object containing
`"documentation":"/openapi.json"`; the second should return a document whose
`openapi` field is `3.1.0` and whose `paths` include `/v1/verify`.

Then make a real verification call. Using `source_content` isolates this check
from source-fetch failures, although it still calls the configured inference
provider:

```sh
curl --fail-with-body --include http://localhost:8080/v1/verify \
  --header 'Content-Type: application/json' \
  --data '{
    "claim": "The Eiffel Tower was completed in 1889.",
    "source_content": "The Eiffel Tower was constructed from 1887 to 1889."
  }'
```

A working end-to-end call returns HTTP `200` and the result fields shown below.
The exact verdict, score, comments, and quote can vary because this is a live
model call. HTTP `502` with `stage: "provider"` means the local HTTP endpoint
worked but its inference upstream was unavailable; it is not a successful
end-to-end check.

For a deterministic check that makes no external inference or source-fetch
requests, run the API test file:

```sh
node --test tests/verify_api.test.js
```

It exercises route discovery, OpenAPI publication, request validation, CORS,
rate limiting, body limits, and the complete HTTP-to-pipeline adapter with an
injected model response. Run `npm test` to execute the whole repository suite.

## `POST /v1/verify`

The running service publishes its machine-readable OpenAPI 3.1 contract at
`GET /openapi.json`; `GET /` links to that contract and this operation.

Send `Content-Type: application/json` with:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `claim` | string | yes | Claim to check; maximum 10,000 characters. |
| `source_url` | string | one source field | Absolute HTTP(S) source URL, fetched through the `tf-source-fetcher` Toolforge tool. |
| `source_content` | string | one source field | Source text; maximum 50,000 characters. Takes precedence if both fields are present; whitespace-only text counts as absent. |
| `page` | positive integer | no | Page to extract from a PDF at `source_url`. |

The endpoint intentionally has no provider or model parameter. Every request
uses the `huggingface` provider (`openai/gpt-oss-20b`, named in
`core/models.js`), the same model as the userscript and CLI default, reached
through the `tf-llm-router` Toolforge tool's `/hf` route rather than the
personal Cloudflare worker. It was chosen over Lift Wing (`liftwing`) on
2026-09-27: ~1.5 s per text-only check against ~24 s for Lift Wing on either
route, and 65% exact accuracy against 50% on the benchmark's 181 rows (binary
accuracy is level, ~72%).

### Copyable example

```sh
curl --fail-with-body http://localhost:8080/v1/verify \
  --header 'Content-Type: application/json' \
  --data '{
    "claim": "The Eiffel Tower was completed in 1889.",
    "source_content": "The Eiffel Tower was constructed from 1887 to 1889."
  }'
```

Successful response (the exact verdict and prose depend on the model):

```json
{
  "verdict": "SUPPORTED",
  "support_score": 95,
  "comments": "The source directly gives the completion year.",
  "reason_type": null,
  "source_quote": "constructed from 1887 to 1889",
  "quote_status": "exact",
  "verified_text": "constructed from 1887 to 1889"
}
```

Only `verified_text` is safe to display as evidence. `source_quote` is the
model's untrusted answer and is retained for parity and diagnostics.

### Errors and limits

Errors have `{ "error": "..." }`; pipeline failures also include `stage`.

| Status | Meaning |
| --- | --- |
| `400` | Invalid JSON field or value. |
| `413` | Request body exceeds 368,192 bytes. Sized so the character limits above are always the ones reached first, in any script, even when every character is sent as a `\uXXXX` escape. |
| `415` | Request is not `application/json`. |
| `422` | Source unavailable or empty. |
| `429` | Service-wide request limit exceeded; honor `Retry-After`. |
| `502` | Provider failure or unreadable model response. |

The included server permits 30 requests/minute **in total, across all
callers**, and its `RateLimit-*` headers describe that shared budget. It is not
per client because on Toolforge it cannot be: the front proxy hides client IP
addresses from tools and sends no `X-Forwarded-For`
([T228500](https://phabricator.wikimedia.org/T228500)), so every request
arrives from the proxy's address. The budget is sized against `tf-llm-router`,
which the batch sweeps also call: 30/minute is 0.5 calls/s, under a
quarter of the ~2.2 calls/s peak measured in
[`design-plans/2026-08-25-verify-concurrency-and-the-fetch-question.md`](design-plans/2026-08-25-verify-concurrency-and-the-fetch-question.md).
The accepted cost of a global limit is that one heavy caller can use the whole
budget.

CORS response headers are emitted only for HTTPS `*.wikipedia.org` origins.
CORS is not authentication: command-line and server callers can still use the
public endpoint. URL sources go through `tf-source-fetcher`, so
the API adds no direct-fetch path or bypass around that service's URL policy.

## Audit findings and decisions needed

Corrections to the commission's hypotheses:

* This repository contains clients for the Cloudflare proxy, Toolforge
  `tf-source-fetcher`, and Toolforge `tf-llm-router`; it does **not** contain
  those deployed services or an existing HTTP web app to extend.
* `core/pipeline.js` provides a single-citation five-step pipeline. The
  userscript does not call that top-level function, though it shares the
  prompt, provider, parser, and quote modules below it.
* The source-fetcher and LLM router are separate Toolforge tools. The legacy
  Cloudflare base remains the default source-fetch/keyless-model route.
* `ccs verify` is limited to English Wikipedia `/wiki/` URLs. It accepts
  `?oldid=`, fetches RESTBase HTML, and parses it with JSDOM as believed.
* The repo has fixtures and unit tests, but no deterministic before/after
  benchmark for stochastic live LLM output. API tests inject a fixed answer
  and prove delegation to the unchanged pipeline instead.

Before deployment, the maintainer must decide:

1. **Per-citation or whole-article:** recommend this per-citation route first;
   whole-article extraction is a separate contract and orchestration surface.
2. **Migrate the userscript:** recommend no for this change; reconsider after
   the public route has operational evidence.
3. **Production host:** Toolforge; the global rate limit and `tf-llm-router`
   routing above assume it. Recommend a tool of its own rather than `source-verifier`
   (the batch) or `tf-llm-router`: separate quotas, no ToolsDB credentials
   behind a public endpoint, and deploys that can't change code under a
   running sweep.
4. **Prompt changes:** recommend no. This route imports the existing pipeline
   and makes none.

## Cost exposure and deliberately unchanged behaviour

Inference goes through `tf-llm-router` and source fetches through
`tf-source-fetcher`, so neither draws on the personal Cloudflare worker. The
router's `/hf` route calls HuggingFace with whatever credential the router
holds; that account, not this service, is where model usage is billed.
What they do draw on is the two Toolforge tools' capacity, shared with the
batch sweeps: the global limit caps the API at **43,200 checks/day** in total.
No billing system is added.

No prompt, verdict vocabulary, parser, truncation rule, citation grouping,
userscript code, or batch code was changed. No pre-existing verification bug
was found while adding the adapter.
