// The deck: the cards file the builder writes, what the app sends for each
// card, and which card a session sees next.

import { readFileSync, statSync } from 'node:fs';
import { tokenize, tapMatches } from './tokens.js';
import { articleUrl, articleLink, sourceLink, editUrl, fixSummary, talkUrl, talkNote, talkTitle } from './wiki.js';

// Mirrors service/cards/wiki.js's TOPIC_GROUPS (ids and labels only). A test
// keeps the two in step.
export const TOPICS = Object.freeze([
    { id: 'sports', label: 'Sports' },
    { id: 'film-tv', label: 'Film & TV' },
    { id: 'music', label: 'Music' },
    { id: 'history', label: 'History' },
    { id: 'politics', label: 'Politics' },
    { id: 'science', label: 'Science' },
    { id: 'technology', label: 'Technology' },
    { id: 'places', label: 'Places' },
    { id: 'business', label: 'Business' },
    { id: 'books', label: 'Books' },
    { id: 'video-games', label: 'Video games' },
    { id: 'food', label: 'Food & drink' },
]);
export const ANY_TOPIC = 'any';

/**
 * Reads the cards file, and re-reads it when it changes on disk (the
 * builder replaces it daily with a rename, so a read never sees half a file).
 */
export function createDeck({ file = null, cards = null, statImpl = statSync, readImpl = readFileSync } = {}) {
    let loaded = cards ? { cards, generatedAt: null } : { cards: [], generatedAt: null };
    let byId = new Map(loaded.cards.map(c => [c.id, c]));
    let mtime = null;
    const refresh = () => {
        if (!file) return;
        let stat;
        try { stat = statImpl(file); } catch { return; }
        if (mtime !== null && stat.mtimeMs === mtime) return;
        const data = JSON.parse(readImpl(file, 'utf8'));
        loaded = { cards: data.cards || [], generatedAt: data.generatedAt || null };
        byId = new Map(loaded.cards.map(c => [c.id, c]));
        mtime = stat.mtimeMs;
    };
    refresh();
    return {
        refresh,
        all: () => { refresh(); return loaded.cards; },
        get: id => { refresh(); return byId.get(id) || null; },
        generatedAt: () => loaded.generatedAt,
    };
}

/** What the page gets before an answer: the texts and tap targets, never the span. */
export function publicCard(card, { warmUp = false } = {}) {
    return {
        id: card.id,
        pageTitle: card.pageTitle,
        articleUrl: articleUrl(card),
        articleLink: articleLink(card),
        claim: { text: card.claim.text, tokens: tokenize(card.claim.text) },
        quote: { text: card.quote.text },
        sourceLabel: card.sourceLabel,
        sourceUrl: card.sourceUrl,
        sourceLink: sourceLink(card),
        topics: card.topics || [],
        monthlyViews: card.monthlyViews ?? null,
        warmUp,
    };
}

/** What the page gets after an answer: where the disagreement is, and what to do. */
export function reveal(card, { projectPage = null, fixEnabled = true } = {}) {
    const from = card.claim.text.slice(card.claim.span.start, card.claim.span.end);
    const to = card.quote.text.slice(card.quote.span.start, card.quote.span.end);
    return {
        claimSpan: card.claim.span,
        quoteSpan: card.quote.span,
        from,
        to,
        fixEnabled,
        // No replacement text: the person writes the correction (see app.js's
        // flaggedSentence()).
        fix: { editUrl: editUrl(card, { projectPage }), findText: card.findText, summary: fixSummary(card, { projectPage }) },
        ask: { talkUrl: talkUrl(card), title: talkTitle(card), note: talkNote(card) },
    };
}

/** Judges a tap: did it land on the flagged words? */
export function judgeTap(card, tokenIndex) {
    return tapMatches(tokenize(card.claim.text), tokenIndex, card.claim.span);
}

/** Open cards per topic, for the home screen's chips. */
export function topicCounts(cards, isOpen) {
    const counts = Object.fromEntries(TOPICS.map(t => [t.id, 0]));
    let any = 0;
    for (const card of cards) {
        if (!isOpen(card)) continue;
        any += 1;
        for (const topic of card.topics || []) if (topic in counts) counts[topic] += 1;
    }
    return { ...counts, [ANY_TOPIC]: any };
}

/**
 * The next card for a session in a topic: open, not answered by this
 * session, not held by someone else. Among the five most-read such cards,
 * one at random, so two people starting the same topic don't race for one
 * sentence.
 */
export function nextCard(cards, { topic = ANY_TOPIC, isAvailable, random = Math.random, pool = 5 }) {
    const eligible = cards.filter(c => (topic === ANY_TOPIC || (c.topics || []).includes(topic)) && isAvailable(c));
    if (!eligible.length) return null;
    eligible.sort((a, b) => (b.monthlyViews ?? -1) - (a.monthlyViews ?? -1));
    const top = eligible.slice(0, pool);
    return top[Math.floor(random() * top.length)];
}

/**
 * The parts of a card a fix page needs after the card has left the deck
 * (the builder drops it once its sentence changes): stored in the `fixed`
 * event so share links keep working.
 */
export function snapshot(card) {
    return {
        id: card.id,
        host: card.host,
        pageTitle: card.pageTitle,
        claim: card.claim,
        quote: card.quote,
        sourceLabel: card.sourceLabel,
        sourceUrl: card.sourceUrl,
        topics: card.topics || [],
        monthlyViews: card.monthlyViews ?? null,
        findText: card.findText,
        section: card.section,
    };
}
