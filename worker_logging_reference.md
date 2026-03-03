# Worker-side Logging Implementation Reference

## Root cause of the current 400 error

The worker has **no `/log` route**. Every POST request, regardless of path,
is forwarded to the PublicAI chat completions API. When `main.js` posts to
`/log`, PublicAI receives the log payload (article URL, verdict, etc.) and
rejects it as an invalid chat request → HTTP 400, which the worker passes
straight back to the browser.

The `/log` handler must be added to the worker before the catch-all POST
block that proxies requests to PublicAI.

---

## Neon DB Schema

Run this migration to add the `model` column (the script now sends it):

```sql
ALTER TABLE verification_logs ADD COLUMN IF NOT EXISTS model TEXT;
```

Full schema for reference:

```sql
CREATE TABLE verification_logs (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT now(),
  article_url TEXT,
  article_title TEXT,
  citation_number TEXT,
  source_url TEXT,
  provider TEXT,
  model TEXT,
  verdict TEXT,
  confidence INT
);
```

---

## Worker fix

The worker already has a `queryNeon` helper and a `cors` headers object — use
both. Add the block below **after** the `GET ?fetch` handler and **before**
the rate-limiter (`const ip = ...`):

```javascript
// --- Verification logging ---
if (request.method === "POST" && url.pathname === "/log") {
  try {
    const body = await request.json();
    if (env.DATABASE_URL) {
      ctx.waitUntil(
        queryNeon(
          env.DATABASE_URL,
          `INSERT INTO verification_logs
             (article_url, article_title, citation_number, source_url,
              provider, model, verdict, confidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            body.article_url,
            body.article_title,
            body.citation_number,
            body.source_url,
            body.provider,
            body.model || null,
            body.verdict,
            Number.isInteger(body.confidence) ? body.confidence : null,
          ]
        ).catch(() => {})
      );
    }
  } catch (e) {}
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
// --- End verification logging ---
```

### Notes

- The CORS `OPTIONS` preflight is already handled globally at the top of the
  worker (it catches all `OPTIONS` regardless of path), so no separate
  preflight case is needed for `/log`.
- The `cors` object already sends `Access-Control-Allow-Origin:
  https://en.wikipedia.org` when the request origin matches — correct for a
  Wikipedia user script.
- `ctx.waitUntil()` returns the 200 immediately; the DB write happens in the
  background. The `.catch(() => {})` ensures a DB failure never surfaces as
  an error to the client.
- `main.js` now sends `model` (the AI model name, e.g.
  `claude-sonnet-4-20250514`) and casts `confidence` to an integer, so the
  payload is ready once the worker handler is in place.
