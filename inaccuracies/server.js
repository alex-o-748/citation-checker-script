#!/usr/bin/env node
// The Inaccuracies web app: one static page, a small JSON API, share pages
// with link previews. No framework, no model calls, no third-party resources.
//
// Configuration (environment):
//   PORT           port to listen on (Toolforge sets it)
//   CARDS_FILE     the cards file service/run-build-cards.js writes
//   EVENTS_FILE    where answers and fixes are appended (JSON lines)
//   BASE_URL       public origin, e.g. https://inaccuracies.toolforge.org
//                  (link previews need absolute URLs)
//   PROJECT_PAGE   on-wiki page linked from edit summaries, e.g.
//                  User:Alaexis/Inaccuracies
//   FIX_OVERRIDE   "on" or "off": the owner's switch over the stop rule
//   WIKI_CHECKS    "off" to skip calls to Wikipedia (local development only:
//                  "Did it work?" then always says yes)
//   FONT_DIR       folder of .ttf/.otf files for the preview images

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createStore, fixGate } from './lib/store.js';
import { createDeck, publicCard, reveal, judgeTap, topicCounts, nextCard, snapshot, TOPICS, ANY_TOPIC } from './lib/cards.js';
import { checkSentence, revertedRevisions } from './lib/wiki.js';
import { metaTags, pageMeta } from './lib/share.js';
import { fixSvg, puzzleSvg, renderPng } from './lib/og.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
};

const SESSION = /^[A-Za-z0-9-]{8,64}$/;
const CARD_ID = /^[0-9a-f]{12}$/;
const MAX_BODY = 4096;
const CHECK_COOLDOWN_MS = 4000;
const REVERT_WINDOW_MS = 7 * 24 * 3600 * 1000;

function send(res, status, body, headers = {}) {
    const isBuffer = Buffer.isBuffer(body);
    const payload = isBuffer || typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': isBuffer || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
    });
    res.end(payload);
}

async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw Object.assign(new Error('invalid JSON'), { status: 400 });
    }
}

/**
 * The app, with every outside dependency injectable. Returns the request
 * handler plus the background revert check, so tests can drive both.
 */
export function createApp({
    deck,
    store,
    fetchImpl = fetch,
    baseUrl = null,
    projectPage = null,
    fixOverride = null,
    wikiChecks = true,
    fontDir = null,
    now = () => new Date(),
    random = Math.random,
    readPublic = name => readFile(join(PUBLIC, name)),
} = {}) {
    const lastCheck = new Map();
    const pngCache = new Map();

    const gate = () => fixGate(store.state.fixes, { override: fixOverride });
    const isOpen = card => store.card(card.id).status === 'open';
    const fixedSnapshot = id => store.state.cards.get(id)?.fix?.snapshot || null;
    const absolute = path => (baseUrl ? `${baseUrl.replace(/\/$/, '')}${path}` : null);

    async function page(res, kind, params = {}) {
        const template = (await readPublic('index.html')).toString('utf8');
        let image = null;
        let path = '/';
        if (kind === 'fix') { image = absolute(`/og/f/${params.card.id}.png`); path = `/f/${params.card.id}`; }
        if (kind === 'puzzle') { image = absolute(`/og/c/${params.card.id}.png`); path = `/c/${params.card.id}`; }
        if (kind === 'topic') path = `/t/${params.topicId}`;
        const meta = metaTags({ ...pageMeta(kind, params), url: absolute(path), image });
        send(res, 200, template.replace('<!--META-->', meta), { 'Content-Type': CONTENT_TYPES['.html'], 'Cache-Control': 'no-cache' });
    }

    async function staticFile(res, name) {
        const safe = normalize(name).replace(/^(\.\.[/\\])+/, '');
        if (safe.includes('..')) return send(res, 404, 'Not found');
        try {
            const body = await readPublic(safe);
            send(res, 200, body, { 'Content-Type': CONTENT_TYPES[extname(safe)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' });
        } catch {
            send(res, 404, 'Not found');
        }
    }

    function stats() {
        const fixes = [...store.state.cards.entries()]
            .filter(([, c]) => c.status === 'fixed' && c.fix?.snapshot)
            .sort((a, b) => Date.parse(b[1].fix.at) - Date.parse(a[1].fix.at));
        const latest = fixes[0];
        return {
            fixed: store.state.counts.fixed,
            open: deck.all().filter(isOpen).length,
            latest: latest ? {
                id: latest[0],
                pageTitle: latest[1].fix.snapshot.pageTitle,
                from: latest[1].fix.snapshot.claim.text.slice(latest[1].fix.snapshot.claim.span.start, latest[1].fix.snapshot.claim.span.end),
                to: latest[1].fix.snapshot.quote.text.slice(latest[1].fix.snapshot.quote.span.start, latest[1].fix.snapshot.quote.span.end),
                at: latest[1].fix.at,
            } : null,
        };
    }

    async function api(req, res, url, session) {
        const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
        const route = parts[1];

        if (req.method === 'GET' && route === 'topics') {
            const counts = topicCounts(deck.all(), isOpen);
            return send(res, 200, { topics: TOPICS.map(t => ({ ...t, open: counts[t.id] })), any: counts[ANY_TOPIC], ...stats(), fixEnabled: gate().enabled });
        }

        if (req.method === 'GET' && route === 'next') {
            if (!session) return send(res, 400, { error: 'session' });
            const topic = url.searchParams.get('topic') || ANY_TOPIC;
            if (topic !== ANY_TOPIC && !TOPICS.some(t => t.id === topic)) return send(res, 400, { error: 'topic' });
            const answered = store.answered(session);
            // Warm-up: a new visitor's first card is one already fixed.
            if (answered.size === 0 && url.searchParams.get('warmup') !== 'no') {
                // From the chosen topic when there is one, else any.
                const fixed = [...store.state.cards.entries()].filter(([, c]) => c.status === 'fixed' && c.fix?.snapshot);
                const warm = fixed.find(([, c]) => topic === ANY_TOPIC || (c.fix.snapshot.topics || []).includes(topic)) || fixed[0];
                if (warm) return send(res, 200, { card: publicCard(warm[1].fix.snapshot, { warmUp: true }), left: null });
            }
            const isAvailable = c => isOpen(c) && !answered.has(c.id) && !store.heldByOther(c.id, session);
            const card = nextCard(deck.all(), { topic, isAvailable, random });
            const left = deck.all().filter(c => (topic === ANY_TOPIC || (c.topics || []).includes(topic)) && isAvailable(c)).length;
            return send(res, 200, { card: card ? publicCard(card) : null, left });
        }

        if (req.method === 'GET' && route === 'card' && CARD_ID.test(parts[2] || '')) {
            const id = parts[2];
            const card = deck.get(id);
            const snap = fixedSnapshot(id);
            const status = store.card(id).status;
            if (card && status === 'open') return send(res, 200, { card: publicCard(card), status });
            if (snap) return send(res, 200, { card: publicCard(snap), status, fixed: { ...reveal(snap, { projectPage }), at: store.card(id).fix.at } });
            if (card) return send(res, 200, { card: publicCard(card), status });
            return send(res, 404, { error: 'not_found' });
        }

        if (req.method === 'POST' && route === 'answer') {
            if (!session) return send(res, 400, { error: 'session' });
            const body = await readJson(req);
            const card = deck.get(body.card) || fixedSnapshot(body.card);
            if (!card) return send(res, 404, { error: 'not_found' });
            const warmUp = Boolean(fixedSnapshot(body.card)) && store.card(body.card).status !== 'open';
            let kind;
            let result;
            if (body.kind === 'tap') {
                const hit = judgeTap(card, Number(body.token));
                kind = hit ? 'caught' : 'miss';
                result = hit ? 'caught' : 'miss';
            } else if (body.kind === 'confirm') {
                kind = body.value === true ? 'confirm_yes' : 'confirm_no';
                result = body.value === true ? 'caught' : 'same';
            } else if (body.kind === 'same' || body.kind === 'skip') {
                kind = body.kind;
                result = body.kind;
            } else {
                return send(res, 400, { error: 'kind' });
            }
            // Warm-up answers teach the tap; they don't count toward a card.
            if (!warmUp) store.record({ t: 'answer', card: card.id, session, kind });
            if (result === 'skip') return send(res, 200, { result });
            return send(res, 200, { result, warmUp, ...reveal(card, { projectPage, fixEnabled: gate().enabled && !warmUp }) });
        }

        if (req.method === 'POST' && route === 'hold') {
            if (!session) return send(res, 400, { error: 'session' });
            const body = await readJson(req);
            const card = deck.get(body.card);
            if (!card || store.card(card.id).status !== 'open') return send(res, 404, { error: 'not_open' });
            if (body.action !== 'fix' && body.action !== 'ask') return send(res, 400, { error: 'action' });
            if (body.action === 'fix' && !gate().enabled) return send(res, 403, { error: 'fix_disabled' });
            if (store.heldByOther(card.id, session)) return send(res, 409, { error: 'held' });
            store.record({ t: 'hold', card: card.id, session, action: body.action });
            return send(res, 200, { held: true });
        }

        if (req.method === 'POST' && route === 'check') {
            if (!session) return send(res, 400, { error: 'session' });
            const body = await readJson(req);
            const card = deck.get(body.card);
            const state = store.card(body.card);
            if (state.status === 'fixed') return send(res, 200, { fixed: true, revisionId: state.fix.revisionId });
            if (!card) return send(res, 404, { error: 'not_found' });
            const last = lastCheck.get(card.id) || 0;
            if (now().getTime() - last < CHECK_COOLDOWN_MS) return send(res, 429, { error: 'too_soon' });
            lastCheck.set(card.id, now().getTime());
            let outcome;
            if (!wikiChecks) outcome = { changed: true, revisionId: null };
            else {
                try {
                    outcome = await checkSentence(card, { fetchImpl });
                } catch (error) {
                    return send(res, 502, { error: 'wiki_unavailable', message: error.message });
                }
            }
            if (!outcome.changed) return send(res, 200, { fixed: false });
            store.record({ t: 'fixed', card: card.id, session, revisionId: outcome.revisionId, snapshot: snapshot(card) });
            return send(res, 200, { fixed: true, revisionId: outcome.revisionId });
        }

        if (req.method === 'POST' && route === 'asked') {
            if (!session) return send(res, 400, { error: 'session' });
            const body = await readJson(req);
            if (!deck.get(body.card)) return send(res, 404, { error: 'not_found' });
            store.record({ t: 'asked', card: body.card, session });
            return send(res, 200, { asked: true });
        }

        if (req.method === 'POST' && route === 'shared') {
            const body = await readJson(req);
            if (!CARD_ID.test(String(body.card || '')) || !['fix', 'puzzle', 'topic'].includes(body.kind)) return send(res, 400, { error: 'share' });
            store.record({ t: 'shared', card: body.card, session, kind: body.kind, platform: String(body.platform || '').slice(0, 20) });
            return send(res, 200, { ok: true });
        }

        return send(res, 404, { error: 'not_found' });
    }

    async function og(res, kind, id) {
        const card = kind === 'f' ? fixedSnapshot(id) : (deck.get(id) || fixedSnapshot(id));
        if (!card) return send(res, 404, 'Not found');
        const key = `${kind}/${id}`;
        let png = pngCache.get(key);
        if (!png) {
            png = await renderPng(kind === 'f' ? fixSvg(card) : puzzleSvg(card), { fontDir });
            if (!png) return send(res, 404, 'Preview images are not available');
            pngCache.set(key, png);
        }
        send(res, 200, png, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    }

    async function handle(req, res) {
        try {
            const url = new URL(req.url, 'http://localhost');
            const rawSession = req.headers['x-session'];
            const session = typeof rawSession === 'string' && SESSION.test(rawSession) ? rawSession : null;
            const path = url.pathname;

            if (path.startsWith('/api/')) return await api(req, res, url, session);
            if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

            let m;
            if ((m = path.match(/^\/og\/(c|f)\/([0-9a-f]{12})\.png$/))) return await og(res, m[1], m[2]);
            if (path === '/' || path === '/about') return await page(res, 'home');
            if ((m = path.match(/^\/t\/([a-z-]+)$/))) {
                const topic = TOPICS.find(t => t.id === m[1]);
                if (!topic) return send(res, 404, 'Not found');
                const counts = topicCounts(deck.all(), isOpen);
                return await page(res, 'topic', { topicId: topic.id, count: counts[topic.id] });
            }
            if ((m = path.match(/^\/c\/([0-9a-f]{12})$/))) {
                const card = deck.get(m[1]) || fixedSnapshot(m[1]);
                return card ? await page(res, 'puzzle', { card }) : await page(res, 'home');
            }
            if ((m = path.match(/^\/f\/([0-9a-f]{12})$/))) {
                const card = fixedSnapshot(m[1]);
                return card ? await page(res, 'fix', { card }) : await page(res, 'home');
            }
            if (/^\/[a-z0-9-]+\.(js|css|svg|png|ico|txt)$/.test(path)) return await staticFile(res, path.slice(1));
            return send(res, 404, 'Not found');
        } catch (error) {
            const status = error.status || 500;
            if (status === 500) console.error(error);
            if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal' : error.message });
        }
    }

    /**
     * Marks fixes reverted within a week of being made. Run hourly; one
     * batched API call per wiki.
     */
    async function checkReverts() {
        if (!wikiChecks) return 0;
        const cutoff = now().getTime() - REVERT_WINDOW_MS;
        const pending = [...store.state.cards.entries()]
            .filter(([, c]) => c.status === 'fixed' && c.fix?.revisionId && Date.parse(c.fix.at) >= cutoff);
        const byHost = new Map();
        for (const [id, c] of pending) {
            const host = c.fix.snapshot?.host;
            if (!host) continue;
            if (!byHost.has(host)) byHost.set(host, []);
            byHost.get(host).push([id, c.fix.revisionId]);
        }
        let marked = 0;
        for (const [host, entries] of byHost) {
            const reverted = await revertedRevisions(host, entries.map(([, rev]) => rev), { fetchImpl });
            for (const [id, rev] of entries) {
                if (reverted.has(rev)) { store.record({ t: 'reverted', card: id, revisionId: rev }); marked += 1; }
            }
        }
        return marked;
    }

    return { handle, checkReverts, gate };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const env = process.env;
    const deck = createDeck({ file: env.CARDS_FILE || join(HERE, 'dev', 'sample-cards.json') });
    const store = createStore({ file: env.EVENTS_FILE || null });
    const app = createApp({
        deck,
        store,
        baseUrl: env.BASE_URL || null,
        projectPage: env.PROJECT_PAGE || null,
        fixOverride: env.FIX_OVERRIDE || null,
        wikiChecks: env.WIKI_CHECKS !== 'off',
        fontDir: env.FONT_DIR || null,
    });
    const port = Number(env.PORT || 8000);
    createServer(app.handle).listen(port, () => console.log(`inaccuracies: listening on ${port}`));
    const revertTimer = setInterval(() => app.checkReverts().catch(e => console.error(`revert check: ${e.message}`)), 3600 * 1000);
    revertTimer.unref();
}
