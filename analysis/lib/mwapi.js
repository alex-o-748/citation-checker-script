// A deliberately slow MediaWiki Action API client.
//
// Wikimedia's API etiquette (https://www.mediawiki.org/wiki/API:Etiquette):
// a descriptive User-Agent with a way to reach the operator, requests made in
// series rather than in parallel, maxlag=5 so the API can turn us away while
// replication lags, and backing off when told to (429, 503, a maxlag error,
// Retry-After). This client does exactly that, and nothing faster: one request
// in flight, at least `minIntervalMs` apart.
//
// Revision *text* always comes from here, even in replicas mode — the Wiki
// Replicas carry no page content.

export const DEFAULT_USER_AGENT =
    'citation-checker-script-edit-impact/0.1 (https://github.com/alex-o-748/citation-checker-script; research, low volume)';

export function hostForWiki(wiki) {
    return wiki.endsWith('wiki') ? `${wiki.slice(0, -4)}.wikipedia.org` : `${wiki}.wikipedia.org`;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createApiClient({
    wiki = 'enwiki',
    userAgent = DEFAULT_USER_AGENT,
    minIntervalMs = 1000,
    maxRetries = 6,
    timeoutMs = 60000,
    maxWaitMs = 300000,
    fetchImpl = fetch,
    sleepFn = sleep,
    now = () => Date.now(),
    log = () => {},
} = {}) {
    const endpoint = `https://${hostForWiki(wiki)}/w/api.php`;
    let lastRequestAt = 0;
    let requests = 0;

    async function call(params) {
        const query = new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params });
        for (let attempt = 0; ; attempt++) {
            const wait = lastRequestAt + minIntervalMs - now();
            if (wait > 0) await sleepFn(wait);
            lastRequestAt = now();
            requests++;
            let response;
            let body = null;
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeoutMs);
                try {
                    response = await fetchImpl(`${endpoint}?${query}`, {
                        headers: { 'User-Agent': userAgent, 'Api-User-Agent': userAgent },
                        signal: controller.signal,
                    });
                    if (response.ok) body = await response.json();
                } finally {
                    clearTimeout(timer);
                }
            } catch (error) {
                const reason = error.name === 'AbortError' ? `no response in ${Math.round(timeoutMs / 1000)}s` : error.message;
                if (attempt >= maxRetries) throw new Error(`MediaWiki API: ${reason}, after ${attempt + 1} attempts`);
                const delay = backoff(attempt);
                // Logged, so a slow stretch never looks like a hang.
                log(`api: ${reason}; retry ${attempt + 1}/${maxRetries} in ${Math.round(delay / 1000)}s`);
                await sleepFn(delay);
                continue;
            }
            const lagged = body?.error?.code === 'maxlag';
            if (response.status === 429 || response.status >= 500 || lagged) {
                if (attempt >= maxRetries) throw new Error(`MediaWiki API: gave up after ${attempt + 1} attempts (HTTP ${response.status}${lagged ? ', maxlag' : ''})`);
                const retryAfter = Number(response.headers?.get?.('retry-after'));
                // Honour Retry-After, but never sleep longer than maxWaitMs on one call.
                const delay = Math.min(maxWaitMs, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
                log(`api: HTTP ${response.status}${lagged ? ' maxlag' : ''}, waiting ${Math.round(delay / 1000)}s`);
                await sleepFn(delay);
                continue;
            }
            if (!response.ok) throw new Error(`MediaWiki API: HTTP ${response.status}`);
            if (body?.error) throw new Error(`MediaWiki API: ${body.error.code}: ${body.error.info}`);
            return body;
        }
    }

    function backoff(attempt) {
        return Math.min(120000, 5000 * 2 ** attempt);
    }

    /** Follows `continue` until done, handing each response to `onPage`. */
    async function callAll(params, onPage) {
        let cont = {};
        for (;;) {
            const body = await call({ ...params, ...cont });
            onPage(body);
            if (!body.continue) return;
            cont = body.continue;
        }
    }

    return { call, callAll, endpoint, get requests() { return requests; } };
}

const META_PROPS = 'ids|timestamp|user|userid|tags|size|comment|flags|sha1';

function toMeta(pageId, rev) {
    return {
        page_id: pageId,
        rev_id: rev.revid,
        parent_id: rev.parentid ?? null,
        timestamp: rev.timestamp,
        user: rev.userhidden ? null : (rev.user ?? null),
        user_id: rev.userid ?? 0,
        anon: Boolean(rev.anon),
        temp: Boolean(rev.temp) || /^~\d/.test(rev.user ?? ''),
        tags: rev.tags ?? [],
        size: rev.size ?? null,
        minor: Boolean(rev.minor),
        comment: rev.commenthidden ? null : (rev.comment ?? ''),
        sha1: rev.sha1hidden ? null : (rev.sha1 ?? null),
        text_hidden: Boolean(rev.texthidden),
    };
}

/** Revisions of one page in [from, until), oldest first. */
export async function listRevisions(client, pageId, { from, until }) {
    const out = [];
    const params = {
        action: 'query', prop: 'revisions', pageids: String(pageId), rvprop: META_PROPS,
        rvdir: 'newer', rvstart: from, rvlimit: 'max',
    };
    if (until) params.rvend = until;
    await client.callAll(params, body => {
        for (const page of body.query?.pages ?? []) {
            for (const rev of page.revisions ?? []) out.push(toMeta(page.pageid, rev));
        }
    });
    // rvend is inclusive; the window is half-open.
    return until ? out.filter(r => r.timestamp < until) : out;
}

/** The last revision at or before `at` (the baseline), with its text. */
export async function baselineRevision(client, pageId, at) {
    const body = await client.call({
        action: 'query', prop: 'revisions', pageids: String(pageId),
        rvprop: `${META_PROPS}|content`, rvslots: 'main', rvdir: 'older', rvstart: at, rvlimit: '1',
    });
    const page = body.query?.pages?.[0];
    if (!page || page.missing) return null;
    const rev = page.revisions?.[0];
    if (!rev) return null;
    return { meta: toMeta(page.pageid, rev), text: rev.slots?.main?.content ?? null };
}

/**
 * Text of many revisions by id. Map rev_id → text|null.
 *
 * Batched by count and, when `sizes` (rev_id → bytes) is given, by total size
 * too: twenty revisions of a 400 KB article is an 8 MB response, slow enough
 * to look like a hang and pointless to hold in memory at once.
 */
export async function revisionTexts(client, revIds, { batchSize = 20, maxBytes = 3_000_000, sizes = null } = {}) {
    const texts = new Map();
    const chunks = [];
    let chunk = [];
    let bytes = 0;
    for (const id of revIds) {
        const size = sizes?.get(id) ?? 0;
        if (chunk.length && (chunk.length >= batchSize || bytes + size > maxBytes)) { chunks.push(chunk); chunk = []; bytes = 0; }
        chunk.push(id);
        bytes += size;
    }
    if (chunk.length) chunks.push(chunk);
    for (const ids of chunks) {
        const body = await client.call({
            action: 'query', prop: 'revisions', revids: ids.join('|'), rvprop: 'ids|content', rvslots: 'main',
        });
        for (const page of body.query?.pages ?? []) {
            for (const rev of page.revisions ?? []) texts.set(rev.revid, rev.slots?.main?.content ?? null);
        }
        for (const id of ids) if (!texts.has(id)) texts.set(id, null);
    }
    return texts;
}

/** Usernames in the 'bot' group, from a list of names. */
export async function botUsers(client, names) {
    const bots = new Set();
    const unique = [...new Set(names.filter(Boolean))];
    for (let i = 0; i < unique.length; i += 50) {
        const body = await client.call({ action: 'query', list: 'users', ususers: unique.slice(i, i + 50).join('|'), usprop: 'groups' });
        for (const user of body.query?.users ?? []) if ((user.groups ?? []).includes('bot')) bots.add(user.name);
    }
    return bots;
}

/** Page ids for titles (validation runs name pages; batch rows already carry ids). */
export async function pageIdsForTitles(client, titles) {
    const ids = new Map();
    for (let i = 0; i < titles.length; i += 50) {
        const body = await client.call({ action: 'query', titles: titles.slice(i, i + 50).join('|') });
        for (const page of body.query?.pages ?? []) if (!page.missing) ids.set(page.title, page.pageid);
    }
    return ids;
}
