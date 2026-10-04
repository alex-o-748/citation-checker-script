# Citation Verifier API

Checks whether a source supports a claim. Send a claim and a source (a URL, or
the source's text), and get back a verdict and a quote from the source that
shows why.

```
https://citation-verifier.toolforge.org
```

It runs the same checks as the
[Source Verifier user script](https://en.wikipedia.org/wiki/User:Alaexis/AI_Source_Verification),
on Wikimedia Toolforge. No API key or account is needed.

## Quick start

```sh
curl https://citation-verifier.toolforge.org/v1/verify \
  -H 'Content-Type: application/json' \
  -d '{
    "claim": "The Eiffel Tower was completed in 1889.",
    "source_url": "https://en.wikipedia.org/wiki/Eiffel_Tower"
  }'
```

```json
{
  "verdict": "SUPPORTED",
  "support_score": 95,
  "comments": "The infobox explicitly states the completion date as 31 March 1889, confirming the claim.",
  "reason_type": null,
  "source_quote": "Completed 31 March 1889",
  "quote_status": "exact",
  "verified_text": "Completed 31 March 1889"
}
```

A check takes about a second when you send the source text, and typically
10–15 seconds when the service has to fetch a URL. Set your client's timeout
well above that.

## `POST /v1/verify`

Send a JSON body with `Content-Type: application/json`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `claim` | string | yes | The statement to check, up to 10,000 characters. |
| `source_url` | string | one of these two | An `http` or `https` URL. The service fetches the page (or PDF) itself. |
| `source_content` | string | one of these two | The source's text, up to 50,000 characters. Used instead of `source_url` if you send both. Useful for paywalled, offline or already-fetched sources. |
| `page` | integer ≥ 1 | no | For a PDF at `source_url`: the page to read. |

Any other field is rejected, so a typo fails loudly instead of being ignored.

### Response

| Field | Meaning |
| --- | --- |
| `verdict` | `SUPPORTED`, `PARTIALLY SUPPORTED`, `NOT SUPPORTED`, or `SOURCE UNAVAILABLE`. |
| `support_score` | 0–100: how strongly the source supports the claim. |
| `comments` | A short explanation of the verdict, in English. |
| `reason_type` | For `NOT SUPPORTED` only: `contradiction` (the source says something incompatible) or `omission` (the source doesn't address the claim). Otherwise `null`. |
| `verified_text` | **The quote to show.** The part of the model's quote that was actually found in the source, character for character. Empty when nothing could be confirmed. |
| `source_quote` | The quote exactly as the model gave it. It may be paraphrased or wrong, so don't show it as evidence; use `verified_text`. |
| `quote_status` | How the quote matched the source: `exact`, `normalized` (matched after ignoring case, quote marks, dashes and spacing), `partial` (only some fragments found), `not-found`, `too-short`, `empty` (no quote given, which is normal for omissions and unavailable sources), or `no-source`. |

The verdict comes from a language model
([`openai/gpt-oss-20b`](https://huggingface.co/openai/gpt-oss-20b)), so treat
it as a lead for a human to check, not a ruling. The quote in `verified_text`
is the part you can rely on: it is always text from the source.

### Errors

Errors return `{ "error": "…" }`. Errors from the checking pipeline also
include `stage`: `source`, `provider` or `parse`.

| Status | Meaning |
| --- | --- |
| `400` | Missing or invalid field. |
| `413` | Request body too large (the character limits above are always reached first). |
| `415` | Body isn't sent as `application/json`. |
| `422` | The source couldn't be fetched, or was empty. Includes `source_status`, the HTTP status the source returned, when there was one. Try sending its text as `source_content`. |
| `429` | The service's request limit is used up. Wait for the number of seconds in `Retry-After`. |
| `502` | The model call failed or returned something unreadable. Usually temporary. |

## `POST /v1/search`

A web search for pages that might source a claim, for tools that cannot call a
search engine themselves (a Wikipedia user script can reach `*.toolforge.org`,
but not a commercial search API). Search, then check each result with
`/v1/verify`: each result's `text` is ready to send as `source_content`.

```sh
curl https://citation-verifier.toolforge.org/v1/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "KCC Malls: KCC started in 1947 as a textile store in Koronadal"}'
```

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `query` | string | yes | Up to 400 characters. The article title followed by the claim works well. |
| `exclude_domains` | array of strings | no | Up to 50 more domains to leave out. |

The response is `{ "results": [ … ] }`, up to 10, best first, each with `url`,
`title`, `score` (the search engine's relevance, 0–1) and `text`: the passages
that match the query, then the page itself, up to 50,000 characters.

Wikipedia, sites that copy it, social media and other user-generated sites are
always left out. A result is a lead, not a source: whether it states the claim
is what `/v1/verify` is for, and whether it is reliable is for the editor.

The search is [Tavily](https://tavily.com)'s, paid for by this service, so it
has its own limits: 20 searches a minute and a daily budget across all callers.
When either is spent it returns `429`; a daily budget resets at midnight UTC.
`502` means the search provider failed.

## Fair use and limits

This is a free, shared service, with one request budget for **all callers
together**: currently **30 checks per minute** (searches are counted
separately; see above). Every response includes
`RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds until
the budget refills), so a client can pace itself.

Please:

- **Space out bulk work.** Checking every citation in an article is fine; do it
  one request at a time, not all at once.
- **Honour 429s.** Wait for `Retry-After` before retrying.
- **Send `source_content` when you already have the text.** It is faster and
  saves a fetch.
- **Ask before building on it at scale.** If your tool needs more than the
  shared budget allows, open an issue (below) and we can talk about it.

The budget may change. Rely on the headers rather than the number above.

## Using it from a browser

Pages on `https://*.wikipedia.org` can call the API directly: the service sends
the CORS headers for those origins, and `*.toolforge.org` is on Wikipedia's
content-security-policy allowlist. From anywhere else, call it from a server or
the command line.

## Service status

`GET /status` is a live dashboard: whether the service is healthy, how busy it
is, how much of the shared budget is left, response times, and recent requests.
`GET /metrics.json` is the same data for scripts. Neither counts against the
request budget. Counters start from zero whenever the service restarts, and the
dashboard shows its uptime.

The dashboard keeps no request content: no claims, no source text, no URLs.
The only thing recorded about a source is its hostname.

## Machine-readable description

`GET /openapi.json` returns an [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0)
description of both endpoints, and `GET /` links to it.

## Questions and problems

Open an issue at
[github.com/alex-o-748/citation-checker-script](https://github.com/alex-o-748/citation-checker-script/issues).

## Running your own copy

The server is `api/server.js` in this repository, and needs Node 18 or later.

```sh
npm install
npm start            # listens on $PORT, default 8080
npm test             # includes tests/verify_api.test.js, which needs no network
```

`/v1/search` uses the `TAVILY_API_KEY` environment variable, or Tavily's
keyless mode (free, rate-limited) when it is unset. `SEARCH_DAILY_LIMIT` caps
searches per day (default 30; a basic search costs one Tavily credit, and the
free plan has 1,000 a month).

The code comments in `api/server.js`, `api/verify.js` and `api/search.js` explain how it is set
up: why the request limit is shared rather than per caller, and which model and
Toolforge services it calls.
