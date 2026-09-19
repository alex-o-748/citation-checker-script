# Verify API

The Verify API checks **one claim against one source**. It is a thin HTTP
entry point to `core/pipeline.js`; it uses the same source fetch, prompt, model
call, verdict parser, and quote verification as existing core consumers.

> **Deployment status (2026-09-15): not public yet.** This repository does not
> contain credentials or deployment access for either candidate production
> host. The paths below are final, but a public base URL must not be advertised
> until the maintainer confirms the host and deploys it. Run locally with
> `npm start` (default: `http://localhost:8080`).

## `POST /v1/verify`

The running service publishes its machine-readable OpenAPI 3.1 contract at
`GET /openapi.json`; `GET /` links to that contract and this operation.

Send `Content-Type: application/json` with:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `claim` | string | yes | Claim to check; maximum 10,000 characters. |
| `source_url` | string | one source field | Absolute HTTP(S) source URL, fetched through the existing source-fetch path. |
| `source_content` | string | one source field | Source text; maximum 50,000 characters. Takes precedence if both fields are present. |
| `page` | positive integer | no | Page to extract from a PDF at `source_url`. |

The endpoint intentionally has no provider or model parameter. Deployment
selects one existing provider/model pair, avoiding a new model-selection API.

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
| `413` | Request body exceeds 64 KiB. |
| `415` | Request is not `application/json`. |
| `422` | Source unavailable or empty. |
| `429` | Per-client request limit exceeded; honor `Retry-After`. |
| `502` | Provider failure or unreadable model response. |

The included server permits 10 requests/minute per directly connected IP and
returns `RateLimit-*` headers. A production reverse proxy must preserve a
trusted client address; the application does not trust caller-controlled
`X-Forwarded-For`. This is a safe local default, not a claim about either
candidate host's current deployed limit.

CORS response headers are emitted only for HTTPS `*.wikipedia.org` origins.
CORS is not authentication: command-line and server callers can still use the
public endpoint. URL sources go through the existing source-fetch service, so
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
3. **Production host:** unresolved. Both candidates were unreachable from the
   development environment (network proxy HTTP 403), and this repo is not
   authoritative about current deployment. Confirm externally first.
4. **Prompt changes:** recommend no. This route imports the existing pipeline
   and makes none.

## Cost exposure and deliberately unchanged behaviour

No current HuggingFace/PublicAI price or exact deployed request limit is
recorded here, so a defensible dollar figure cannot be derived. At the local
default, one IP can initiate at most **14,400 checks/day**. If average all-in
provider cost is `C` dollars/check, exposure is `14,400 × C` dollars/day/IP,
before stricter upstream limits. Measure `C` from provider usage and replace
this formula with a dated figure before deployment. No billing system is added.

No prompt, verdict vocabulary, parser, truncation rule, citation grouping,
userscript code, or batch code was changed. No pre-existing verification bug
was found while adding the adapter.
