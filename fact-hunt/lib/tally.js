// What people did on the site, counted from the event log (EVENTS_FILE).
// Read-only: it never writes to the log or changes what the app serves.
//
// Counts are of events and of distinct sessions. A session is one browser's
// random id, so "people" here means browsers: one person on two devices is
// two, and clearing site data starts a new one.
//
// Warm-up answers are never recorded (server.js), so a session appears here
// only once it has answered a real card or opened a link.

const ANSWER_ORDER = ['caught', 'miss', 'confirm_yes', 'confirm_no', 'same', 'skip'];

/** Parses JSON lines, skipping blank and torn lines the way the store does. */
export function parseEvents(text) {
    const events = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { /* a torn last line from a crash */ }
    }
    return events;
}

/**
 * Parses --since/--until: an ISO date, or a span back from `now` such as
 * "7d", "24h" or "30m". Returns a millisecond timestamp, or null.
 */
export function parseWhen(value, now = Date.now()) {
    if (value == null || value === '') return null;
    const span = String(value).match(/^(\d+)([dhm])$/);
    if (span) return now - Number(span[1]) * { d: 86400000, h: 3600000, m: 60000 }[span[2]];
    const at = Date.parse(value);
    if (Number.isNaN(at)) throw new Error(`not a date or a span like 7d: ${value}`);
    return at;
}

function bump(map, key, n = 1) { map[key] = (map[key] || 0) + n; }
function addTo(map, key, value) { (map[key] ||= new Set()).add(value); }

function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The tally itself: plain numbers and small tables, JSON-safe. */
export function tally(events, { since = null, until = null, top = 10 } = {}) {
    const inRange = events.filter(e => {
        const at = Date.parse(e.at);
        if (Number.isNaN(at)) return false;
        return (since == null || at >= since) && (until == null || at < until);
    });

    const sessions = new Set();
    const sessionsBy = {}; // action -> Set of sessions
    const answers = {};
    const answersPerSession = new Map();
    const holds = {};
    const shares = { byKind: {}, byPlatform: {} };
    const opened = { article: { before: 0, after: 0 }, source: { before: 0, after: 0 } };
    const cards = new Map();
    let fixed = 0;
    let asked = 0;
    let reverted = 0;
    let first = null;
    let last = null;

    const card = id => {
        let c = cards.get(id);
        if (!c) { c = { card: id, answers: 0, caught: 0, openedArticle: 0, openedSource: 0, fixed: 0 }; cards.set(id, c); }
        return c;
    };

    for (const e of inRange) {
        if (first == null || e.at < first) first = e.at;
        if (last == null || e.at > last) last = e.at;
        if (e.session) sessions.add(e.session);
        const c = e.card ? card(e.card) : null;
        if (e.t === 'answer') {
            bump(answers, e.kind);
            if (e.session) {
                addTo(sessionsBy, 'answered', e.session);
                if (e.kind !== 'skip') answersPerSession.set(e.session, (answersPerSession.get(e.session) || 0) + 1);
                if (e.kind === 'caught' || e.kind === 'confirm_yes') addTo(sessionsBy, 'caught', e.session);
            }
            if (c && e.kind !== 'skip') c.answers += 1;
            if (c && (e.kind === 'caught' || e.kind === 'confirm_yes')) c.caught += 1;
        } else if (e.t === 'hold') {
            bump(holds, e.action);
            if (e.session) addTo(sessionsBy, e.action === 'fix' ? 'startedFix' : 'startedAsk', e.session);
        } else if (e.t === 'fixed') {
            fixed += 1;
            if (c) c.fixed += 1;
            if (e.session) addTo(sessionsBy, 'fixed', e.session);
        } else if (e.t === 'asked') {
            asked += 1;
            if (e.session) addTo(sessionsBy, 'asked', e.session);
        } else if (e.t === 'reverted') {
            reverted += 1;
        } else if (e.t === 'shared') {
            bump(shares.byKind, e.kind || 'unknown');
            bump(shares.byPlatform, e.platform || 'unknown');
            if (e.session) addTo(sessionsBy, 'shared', e.session);
        } else if (e.t === 'opened' && (e.target === 'article' || e.target === 'source')) {
            opened[e.target][e.answered ? 'after' : 'before'] += 1;
            if (e.session) addTo(sessionsBy, e.target === 'article' ? 'openedArticle' : 'openedSource', e.session);
            if (c) c[e.target === 'article' ? 'openedArticle' : 'openedSource'] += 1;
        }
    }

    const count = key => sessionsBy[key]?.size || 0;
    const perSession = [...answersPerSession.values()];
    const byOpens = [...cards.values()]
        .filter(c => c.openedArticle + c.openedSource > 0)
        .sort((a, b) => (b.openedArticle + b.openedSource) - (a.openedArticle + a.openedSource) || b.answers - a.answers)
        .slice(0, top);

    return {
        range: { since: since == null ? null : new Date(since).toISOString(), until: until == null ? null : new Date(until).toISOString(), first, last },
        events: inRange.length,
        sessions: sessions.size,
        // How far sessions got, each counted once however often it acted.
        funnel: {
            answered: count('answered'),
            caught: count('caught'),
            startedFix: count('startedFix'),
            fixed: count('fixed'),
            startedAsk: count('startedAsk'),
            asked: count('asked'),
            shared: count('shared'),
            openedArticle: count('openedArticle'),
            openedSource: count('openedSource'),
        },
        answers: Object.fromEntries(ANSWER_ORDER.filter(k => answers[k]).map(k => [k, answers[k]])),
        cardsPerSession: { median: median(perSession), max: perSession.length ? Math.max(...perSession) : null },
        holds,
        fixed,
        asked,
        reverted,
        shares,
        opened,
        topOpenedCards: byOpens,
    };
}

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '—');

/** The tally as text for a terminal. `titles` maps card id to article title. */
export function formatTally(t, { titles = new Map() } = {}) {
    const f = t.funnel;
    const lines = [];
    lines.push(`Fact Hunt, ${t.range.first ? `${t.range.first.slice(0, 16).replace('T', ' ')} to ${t.range.last.slice(0, 16).replace('T', ' ')} UTC` : 'no events'}`);
    if (t.range.since || t.range.until) lines.push(`  window: ${t.range.since || 'start'} to ${t.range.until || 'now'}`);
    lines.push(`${t.events} events from ${t.sessions} sessions`, '');

    lines.push('Sessions that…');
    const row = (label, n, of = f.answered) => lines.push(`  ${label.padEnd(26)}${String(n).padStart(6)}  ${of === null ? '' : pct(n, of)}`);
    row('answered a card', f.answered, null);
    row('caught one', f.caught);
    row('started a fix', f.startedFix);
    row('had a fix confirmed', f.fixed);
    row('started asking editors', f.startedAsk);
    row('said they posted a note', f.asked);
    row('shared', f.shared);
    row('opened the article', f.openedArticle);
    row('opened the source', f.openedSource);
    lines.push(`  (percentages are of sessions that answered a card)`, '');

    lines.push('Answers');
    for (const [kind, n] of Object.entries(t.answers)) lines.push(`  ${kind.padEnd(26)}${String(n).padStart(6)}`);
    if (t.cardsPerSession.median != null) lines.push(`  cards answered per session: median ${t.cardsPerSession.median}, max ${t.cardsPerSession.max}`);
    lines.push('');

    lines.push('Links followed           before answering  after');
    lines.push(`  to the article         ${String(t.opened.article.before).padStart(16)}  ${String(t.opened.article.after).padStart(5)}`);
    lines.push(`  to the source          ${String(t.opened.source.before).padStart(16)}  ${String(t.opened.source.after).padStart(5)}`);
    lines.push('');

    lines.push(`Outcomes: ${t.fixed} fixed, ${t.reverted} reverted, ${t.asked} talk notes`);
    const platforms = Object.entries(t.shares.byPlatform).map(([k, n]) => `${k} ${n}`).join(', ');
    const kinds = Object.entries(t.shares.byKind).map(([k, n]) => `${k} ${n}`).join(', ');
    lines.push(`Shares: ${platforms || 'none'}${kinds ? ` (${kinds})` : ''}`);

    if (t.topOpenedCards.length) {
        lines.push('', 'Cards whose links were followed most');
        for (const c of t.topOpenedCards) {
            const name = titles.get(c.card) || c.card;
            lines.push(`  ${name.slice(0, 40).padEnd(40)} article ${c.openedArticle}, source ${c.openedSource}, answers ${c.answers}`);
        }
    }
    return lines.join('\n');
}
