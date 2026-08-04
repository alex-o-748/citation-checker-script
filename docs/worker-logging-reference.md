# Worker-side Logging Implementation Reference

## Neon DB Schema

```sql
CREATE TABLE verification_logs (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT now(),
  check_id TEXT UNIQUE,        -- minted client-side, joins feedback to the check
  kind TEXT DEFAULT 'source',  -- 'source' | 'group'
  article_url TEXT,
  article_title TEXT,
  citation_number TEXT,        -- comma-joined for kind='group'
  source_url TEXT,             -- null for kind='group' (several sources)
  provider TEXT,
  model TEXT,
  verdict TEXT,
  confidence INT,
  reason_type TEXT,
  claim_text TEXT,             -- truncated to 2000 chars client-side
  llm_comments TEXT            -- ditto
);
```

Migration for the deployed table, which predates the last five columns:

```sql
ALTER TABLE verification_logs
  ADD COLUMN check_id TEXT UNIQUE,
  ADD COLUMN kind TEXT DEFAULT 'source',
  ADD COLUMN model TEXT,
  ADD COLUMN claim_text TEXT,
  ADD COLUMN llm_comments TEXT;
```

(`reason_type` is already sent by the client; add it too if the deployed table
is older than that change.)

### Why `check_id` is minted in the browser

The client generates the id (`newCheckId()` in `core/feedback.js`) instead of
reading back a `SERIAL`. Logging stays fire-and-forget — the feedback controls
attached to a result are usable immediately, with no round trip to await — and
the id still exists if the log write failed. The cost is that the id is
client-supplied and therefore untrusted; for research telemetry that is an
acceptable trade, but don't build anything security-sensitive on it.

### Why claim text and rationale are stored

A rating against a row that holds only a verdict is uninterpretable: you learn
that check `a7f3k2q9` was wrong without learning what it claimed or why the
model decided that. Both fields are public content already (article prose and
LLM output), and both are capped at `MAX_LOGGED_TEXT` before they leave the
browser.

## Cloudflare Worker Changes

Install the Neon serverless driver:

```
npm install @neondatabase/serverless
```

Add `DATABASE_URL` as a secret in the Worker settings (Cloudflare dashboard > Workers > Settings > Variables > Secrets).

The value should be your Neon connection string, e.g.:
`postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/dbname?sslmode=require`

### Handler code

Add this to the Worker's `fetch` handler, before the existing route logic:

```javascript
import { neon } from '@neondatabase/serverless';

// Inside fetch handler:
if (request.method === 'POST' && url.pathname === '/log') {
  // Return 200 immediately, log in background
  const body = await request.json();
  const sql = neon(env.DATABASE_URL);

  ctx.waitUntil(
    sql`INSERT INTO verification_logs
        (article_url, article_title, citation_number, source_url, provider, verdict, confidence)
        VALUES (${body.article_url}, ${body.article_title}, ${body.citation_number},
                ${body.source_url}, ${body.provider}, ${body.verdict}, ${body.confidence})`
      .catch(err => console.error('Log write failed:', err))
  );

  return new Response('ok', {
    headers: { 'Access-Control-Allow-Origin': '*' }
  });
}

// Also handle CORS preflight for /log:
if (request.method === 'OPTIONS' && url.pathname === '/log') {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
```

### Key points

- `ctx.waitUntil()` lets the response return immediately while the DB write happens in the background
- `neon()` from `@neondatabase/serverless` uses HTTP queries (no TCP), which works in Cloudflare Workers
- CORS headers are needed since the script runs on `en.wikipedia.org` and posts to the Worker domain
- The `.catch()` ensures a failed DB write never surfaces as an error to the client
