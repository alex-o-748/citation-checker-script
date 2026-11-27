// What the card builder asks Wikimedia about each article: its current
// wikitext, whether a new editor can publish there, whether it's a biography
// of a living person, its topics and how many people read it.
//
// Every function takes an injectable fetchImpl, so tests run on recorded
// responses. Requests carry a User-Agent with contact details, as the
// Wikimedia User-Agent policy requires.

import { DEFAULT_USER_AGENT, hostForWiki, langCodeForWiki } from '../../core/wikipedia.js';
import { livingPeopleCategoryForWiki } from '../article-picker.js';

export const USER_AGENT = `${DEFAULT_USER_AGENT} fact-hunt-card-builder`;

// Wikitext is large, so fewer titles per request than the 50 the API allows.
export const PAGE_BATCH_SIZE = 20;

export function buildPageStateUrl(titles, { wiki }) {
    const params = new URLSearchParams({
        action: 'query',
        format: 'json',
        formatversion: '2',
        redirects: '1',
        prop: 'info|revisions|categories|flagged',
        inprop: 'protection',
        rvprop: 'ids|content',
        rvslots: 'main',
        titles: titles.join('|'),
    });
    const category = livingPeopleCategoryForWiki(wiki);
    if (category) params.set('clcategories', `Category:${category}`);
    return `https://${hostForWiki(wiki)}/w/api.php?${params}`;
}

/**
 * Edit protection, read from prop=info's protection list. Any edit level
 * counts — semi (autoconfirmed), extended-confirmed, template-editor or
 * full: each stops someone logged out or brand new from publishing.
 */
export function editProtection(page) {
    const entry = (page?.protection || []).find(p => p.type === 'edit');
    return entry ? entry.level : null;
}

/**
 * Pending changes (FlaggedRevs): an edit by a new account waits for review,
 * where the app can't see it. prop=flagged reports protection_level on a
 * page under pending-changes protection.
 */
export function pendingChanges(page) {
    return page?.flagged?.protection_level ?? null;
}

/**
 * The state of each title, keyed by the title as asked (redirects followed):
 * { pageId, title, revisionId, wikitext, protection, pendingChanges, isBlp,
 *   missing }. isBlp is null where the wiki has no known living-people
 * category, so the caller can refuse rather than guess.
 */
export async function fetchPageStates(titles, { wiki, fetchImpl = fetch, batchSize = PAGE_BATCH_SIZE } = {}) {
    const states = new Map();
    const unique = [...new Set(titles)];
    const hasBlpCategory = Boolean(livingPeopleCategoryForWiki(wiki));
    for (let i = 0; i < unique.length; i += batchSize) {
        const batch = unique.slice(i, i + batchSize);
        const response = await fetchImpl(buildPageStateUrl(batch, { wiki }), { headers: { 'User-Agent': USER_AGENT } });
        if (!response.ok) throw new Error(`Wikipedia API returned HTTP ${response.status} reading page states`);
        const data = await response.json();
        const query = data.query || {};
        // Map each asked title through normalization and redirects to the
        // title the page came back under.
        const resolve = new Map(batch.map(t => [t, t]));
        for (const n of query.normalized || []) {
            for (const [asked, now] of resolve) if (now === n.from) resolve.set(asked, n.to);
        }
        for (const r of query.redirects || []) {
            for (const [asked, now] of resolve) if (now === r.from) resolve.set(asked, r.to);
        }
        const byTitle = new Map((query.pages || []).map(p => [p.title, p]));
        for (const [asked, title] of resolve) {
            const page = byTitle.get(title);
            if (!page || page.missing || page.invalid) {
                states.set(asked, { missing: true, title });
                continue;
            }
            const revision = page.revisions?.[0];
            states.set(asked, {
                missing: false,
                pageId: page.pageid,
                title: page.title,
                revisionId: revision?.revid ?? null,
                wikitext: revision?.slots?.main?.content ?? null,
                protection: editProtection(page),
                pendingChanges: pendingChanges(page),
                isBlp: hasBlpCategory ? (page.categories || []).length > 0 : null,
            });
        }
    }
    return states;
}

// --- Topics (Lift Wing's language-agnostic outlink topic model) ---

export const TOPIC_ENDPOINT = 'https://api.wikimedia.org/service/lw/inference/v1/models/outlink-topic-model:predict';
export const TOPIC_THRESHOLD = 0.5;

// The app's topic chips, each a group of the model's 64 labels (matched by
// prefix). Order is the order on the home screen.
export const TOPIC_GROUPS = Object.freeze([
    { id: 'sports', label: 'Sports', prefixes: ['Culture.Sports'] },
    { id: 'film-tv', label: 'Film & TV', prefixes: ['Culture.Media.Films', 'Culture.Media.Television', 'Culture.Media.Entertainment', 'Culture.Performing arts'] },
    { id: 'music', label: 'Music', prefixes: ['Culture.Media.Music'] },
    { id: 'history', label: 'History', prefixes: ['History and Society.History', 'History and Society.Military and warfare'] },
    { id: 'politics', label: 'Politics', prefixes: ['History and Society.Politics and government'] },
    { id: 'science', label: 'Science', prefixes: ['STEM.Biology', 'STEM.Chemistry', 'STEM.Physics', 'STEM.Space', 'STEM.Earth and environment', 'STEM.Mathematics'] },
    { id: 'technology', label: 'Technology', prefixes: ['STEM.Technology', 'STEM.Computing', 'STEM.Engineering', 'Culture.Media.Software', 'Culture.Internet culture'] },
    { id: 'places', label: 'Places', prefixes: ['Geography.'] },
    { id: 'business', label: 'Business', prefixes: ['History and Society.Business and economics', 'History and Society.Transportation'] },
    { id: 'books', label: 'Books', prefixes: ['Culture.Literature', 'Culture.Media.Books'] },
    { id: 'video-games', label: 'Video games', prefixes: ['Culture.Media.Video games'] },
    { id: 'food', label: 'Food & drink', prefixes: ['Culture.Food and drink'] },
]);

// Left out at launch (design doc: no medicine). A card in any of these is
// dropped even if it also matches a group above.
export const EXCLUDED_TOPIC_PREFIXES = Object.freeze(['STEM.Medicine']);

const normLabel = label => String(label ?? '').replace(/_/g, ' ');

/**
 * Turns the model's labels into the app's topic ids. Returns
 * { topics: [...ids], excluded: label|null }.
 */
export function topicsFromLabels(labels) {
    const names = labels.map(normLabel);
    const excluded = names.find(n => EXCLUDED_TOPIC_PREFIXES.some(p => n.startsWith(p))) ?? null;
    const topics = TOPIC_GROUPS
        .filter(g => names.some(n => g.prefixes.some(p => n.startsWith(p))))
        .map(g => g.id);
    return { topics, excluded };
}

/**
 * The model's labels at or above the threshold. Called one article at a
 * time: the model card warns that the service doesn't handle parallel
 * requests well.
 */
export async function fetchTopicLabels(title, { wiki, fetchImpl = fetch, threshold = TOPIC_THRESHOLD } = {}) {
    const response = await fetchImpl(TOPIC_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        body: JSON.stringify({ page_title: title.replace(/ /g, '_'), lang: langCodeForWiki(wiki), threshold }),
    });
    if (!response.ok) throw new Error(`Lift Wing topic model returned HTTP ${response.status} for ${title}`);
    const data = await response.json();
    return (data?.prediction?.results || [])
        .filter(r => typeof r?.score === 'number' && r.score >= threshold)
        .map(r => normLabel(r.topic));
}

// --- Monthly readers (Pageviews API) ---

/** The last complete calendar month before `now`, as Pageviews timestamps. */
export function lastFullMonth(now = new Date()) {
    const firstOfThis = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const lastOfPrev = new Date(firstOfThis.getTime() - 86400000);
    const firstOfPrev = new Date(Date.UTC(lastOfPrev.getUTCFullYear(), lastOfPrev.getUTCMonth(), 1));
    const stamp = d => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}00`;
    return { start: stamp(firstOfPrev), end: stamp(lastOfPrev) };
}

export function buildPageviewsUrl(title, { wiki, now = new Date() } = {}) {
    const { start, end } = lastFullMonth(now);
    const project = hostForWiki(wiki).replace(/\.org$/, '');
    const article = encodeURIComponent(title.replace(/ /g, '_'));
    return `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${project}/all-access/user/${article}/monthly/${start}/${end}`;
}

/** Views by people (not bots) in the last full month, or null if unknown. */
export async function fetchMonthlyViews(title, { wiki, fetchImpl = fetch, now = new Date() } = {}) {
    const response = await fetchImpl(buildPageviewsUrl(title, { wiki, now }), { headers: { 'User-Agent': USER_AGENT } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Pageviews API returned HTTP ${response.status} for ${title}`);
    const data = await response.json();
    const views = data?.items?.[0]?.views;
    return typeof views === 'number' ? views : null;
}

// --- Language of the source ---

const ENGLISH_FUNCTION_WORDS = new Set(['the', 'of', 'and', 'in', 'to', 'a', 'was', 'is', 'for', 'on', 'by', 'with', 'as', 'at', 'from', 'that', 'were', 'are', 'has', 'had', 'an', 'it', 'its', 'his', 'her', 'their', 'this', 'which', 'be', 'been', 'or', 'not']);

// Function words of the other languages English Wikipedia most often cites in
// Latin script. Words that are also English ("a", "in", "no", "is", "was")
// are left out, so they can't count for both sides.
const OTHER_FUNCTION_WORDS = Object.freeze({
    es: new Set(['el', 'la', 'los', 'las', 'que', 'de', 'del', 'y', 'en', 'un', 'una', 'por', 'con', 'para', 'su', 'sus', 'es', 'era', 'fue', 'se', 'lo', 'al', 'como', 'más', 'pero', 'muy']),
    fr: new Set(['le', 'la', 'les', 'des', 'du', 'et', 'est', 'une', 'un', 'pour', 'dans', 'que', 'qui', 'sur', 'avec', 'au', 'aux', 'était', 'ses', 'ce', 'cette', 'mais', 'pas', 'été']),
    de: new Set(['der', 'die', 'das', 'und', 'ist', 'war', 'ein', 'eine', 'mit', 'von', 'zu', 'den', 'dem', 'nicht', 'sich', 'auf', 'für', 'im', 'auch', 'wurde', 'des']),
    pt: new Set(['o', 'os', 'da', 'do', 'das', 'dos', 'e', 'um', 'uma', 'em', 'para', 'com', 'não', 'foi', 'que', 'seu', 'sua', 'pela', 'pelo', 'mais']),
    it: new Set(['il', 'gli', 'della', 'del', 'che', 'e', 'è', 'un', 'una', 'per', 'con', 'non', 'sono', 'fu', 'nel', 'alla', 'dei', 'più']),
    nl: new Set(['de', 'het', 'een', 'en', 'van', 'niet', 'met', 'voor', 'dat', 'zijn', 'werd', 'ook', 'naar', 'bij']),
});

/**
 * Whether a quote looks like it's in the wiki's language. At launch only
 * English is checked: mostly Latin script, and in a quote of five words or
 * more, more English function words than any one other language's. The
 * first version only asked for one English function word, and a Spanish
 * source passed on its "a" ("se negó a aceptar"). Other wikis pass, and need
 * a rule of their own before they launch.
 */
export function quoteInWikiLanguage(quote, { wiki }) {
    if (langCodeForWiki(wiki) !== 'en') return true;
    const letters = String(quote ?? '').match(/\p{L}/gu) || [];
    if (!letters.length) return false;
    const latin = letters.filter(ch => /\p{Script=Latin}/u.test(ch)).length;
    if (latin / letters.length < 0.9) return false;
    const words = String(quote).toLowerCase().match(/\p{L}+/gu) || [];
    if (words.length < 5) return true;
    const english = words.filter(w => ENGLISH_FUNCTION_WORDS.has(w)).length;
    const other = Math.max(...Object.values(OTHER_FUNCTION_WORDS).map(set => words.filter(w => set.has(w)).length));
    return english > 0 && english > other;
}

/**
 * "lastwordonsports.com" from a URL: the source label a card shows. An
 * archive.org snapshot is labelled by the site it archived, since that is
 * the publication the reader is being asked to trust.
 */
export function sourceLabelFor(url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./, '');
        if (host === 'web.archive.org') {
            const original = parsed.pathname.match(/^\/web\/[^/]+\/(.+)$/);
            if (original) {
                const inner = /^https?:\/\//i.test(original[1]) ? original[1] : `http://${original[1]}`;
                return sourceLabelFor(inner);
            }
        }
        return host;
    } catch {
        return null;
    }
}
