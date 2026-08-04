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

## Feedback endpoint

Ratings and talk-page pointers arrive on a second endpoint. Same shape as
`/log`, with one difference: it **awaits the insert and reports failure**.
`/log` is invisible telemetry and should never surface an error; `/feedback` is
the response to a button the user deliberately pressed, so a silent no-op would
be worse than an error message.

```sql
CREATE TABLE feedback (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT now(),
  check_id TEXT REFERENCES verification_logs(check_id),
  rating SMALLINT,           -- +1 / -1, null for correction-only or comment-only rows
  corrected_verdict TEXT,    -- from the thumbs-down chips
  wiki_section TEXT,         -- talk-page section title, when the editor commented
  client_id TEXT             -- random per-browser token, dedupe only
);

CREATE INDEX feedback_check_id_idx ON feedback (check_id);
```

A single check can produce several rows: a thumbs-down, then a corrected
verdict, then a comment. Only the first carries `rating`, so
`count(*) FILTER (WHERE rating IS NOT NULL)` is the rating count and doesn't
double-count a rating the editor then elaborated on.

```javascript
if (request.method === 'POST' && url.pathname === '/feedback') {
  const body = await request.json();
  const sql = neon(env.DATABASE_URL);

  try {
    await sql`INSERT INTO feedback
        (check_id, rating, corrected_verdict, wiki_section, client_id)
        VALUES (${body.check_id}, ${body.rating}, ${body.corrected_verdict},
                ${body.wiki_section}, ${body.client_id})`;
    return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } });
  } catch (err) {
    console.error('Feedback write failed:', err);
    return new Response('error', {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
}
```

`OPTIONS /feedback` needs the same preflight response as `OPTIONS /log`.

### What is deliberately not stored

No username, on any row. The sidebar tells users that results are logged
without recording who ran them, and a rating is covered by that promise. A
talk-page comment *is* signed — but that signature lives on the wiki, where the
editor chose to put it, not in this table. `wiki_section` points at the
discussion; resolving it to a person means going to the wiki and looking.

`client_id` is a random token minted once per browser in `localStorage`. It
exists so repeat clicks can be collapsed and distinct-ish users counted; it is
not derived from anything about the user and does not survive clearing site
data.

## Feedback routing

Where a piece of feedback goes is decided by what kind of thing it is, not by
where the user clicked:

| Feedback | Destination | Why |
|----------|-------------|-----|
| 👍 / 👎, corrected verdict | Neon, via `POST /feedback` | High volume, only useful aggregated, must join to the check. An edit per rating would be absurd friction and unaggregatable. |
| Written comment | New section on `User talk:Alaexis/AI_Source_Verification` | Needs to be public and to support follow-up questions. A database is a terrible forum. |

`check_id` is on both sides, so the two can be joined: the heading and a
trailing HTML comment on each talk section carry the id, and `wiki_section`
records the heading against the check row at post time — without waiting for
the scheduled talk-page scrape to notice it.

Comments are posted with `mw.Api#postWithEditToken` from inside the sidebar, so
the editor never leaves the article. On wikis other than en.wikipedia the post
goes through `mw.ForeignApi`, since the talk page is always the en.wikipedia
one.
