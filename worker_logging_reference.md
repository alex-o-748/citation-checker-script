# Worker-side Logging Implementation Reference

## Neon DB Schema

```sql
CREATE TABLE verification_logs (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT now(),
  article_url TEXT,
  article_title TEXT,
  citation_number TEXT,
  source_url TEXT,
  provider TEXT,
  verdict TEXT,
  confidence INT
);
```

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
