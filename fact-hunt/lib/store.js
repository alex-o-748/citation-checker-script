// Everything the app records, as an append-only log of events, and the state
// derived from it.
//
// One JSON object per line in a file (EVENTS_FILE). On start the file is
// replayed; each new event is appended and applied. The app runs as one
// webservice process, so there is no concurrent writer. An event log rather
// than rows to update: every count on the site can be recomputed, and a
// mistake in the rules is fixed by replaying, not by patching data.
//
// What is recorded: a random session id the browser made, the card, what
// was done, and when. No IP address (Toolforge's proxy doesn't pass one
// anyway), no user agent, no Wikipedia username.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export const HOLD_MS = 20 * 60 * 1000;
export const DISMISS_AFTER = 2; // "They don’t contradict each other" from this many sessions retires a card.

export const EVENT_TYPES = Object.freeze(['answer', 'hold', 'fixed', 'asked', 'shared', 'reverted']);
export const ANSWER_KINDS = Object.freeze(['caught', 'miss', 'confirm_yes', 'confirm_no', 'same', 'skip']);

function emptyCard() {
    return { caught: 0, misses: 0, skips: 0, same: new Set(), sessions: new Set(), status: 'open', hold: null, fix: null, shares: 0 };
}

export function createState() {
    return { cards: new Map(), sessions: new Map(), fixes: [], counts: { fixed: 0, caught: 0, asked: 0, shared: 0, reverted: 0 } };
}

function cardState(state, id) {
    let c = state.cards.get(id);
    if (!c) { c = emptyCard(); state.cards.set(id, c); }
    return c;
}

function sessionState(state, id) {
    let s = state.sessions.get(id);
    if (!s) { s = { answered: new Set() }; state.sessions.set(id, s); }
    return s;
}

/** Applies one event to the state. Unknown events are ignored, not fatal. */
export function applyEvent(state, e) {
    if (!e || !EVENT_TYPES.includes(e.t) || !e.card) return state;
    const c = cardState(state, e.card);
    const at = Date.parse(e.at) || 0;
    if (e.t === 'answer') {
        if (e.session) {
            sessionState(state, e.session).answered.add(e.card);
            c.sessions.add(e.session);
        }
        if (e.kind === 'caught' || e.kind === 'confirm_yes') { c.caught += 1; state.counts.caught += 1; }
        else if (e.kind === 'miss') c.misses += 1;
        else if (e.kind === 'skip') c.skips += 1;
        else if (e.kind === 'same' || e.kind === 'confirm_no') {
            if (e.session) c.same.add(e.session);
            if (c.status === 'open' && c.same.size >= DISMISS_AFTER) c.status = 'dismissed';
        }
    } else if (e.t === 'hold') {
        c.hold = { session: e.session, action: e.action, until: at + HOLD_MS };
    } else if (e.t === 'fixed') {
        if (c.status !== 'fixed' && c.status !== 'disputed') {
            c.status = 'fixed';
            c.fix = { at: e.at, revisionId: e.revisionId ?? null, snapshot: e.snapshot ?? null, reverted: false };
            c.hold = null;
            state.fixes.push({ card: e.card, at: e.at, revisionId: e.revisionId ?? null, reverted: false });
            state.counts.fixed += 1;
        }
    } else if (e.t === 'asked') {
        if (c.status === 'open') { c.status = 'asked'; state.counts.asked += 1; }
        c.hold = null;
    } else if (e.t === 'shared') {
        c.shares += 1;
        state.counts.shared += 1;
    } else if (e.t === 'reverted') {
        if (c.fix && !c.fix.reverted) {
            c.fix.reverted = true;
            c.status = 'disputed';
            const record = state.fixes.find(f => f.card === e.card && !f.reverted);
            if (record) record.reverted = true;
            state.counts.reverted += 1;
        }
    }
    return state;
}

/**
 * The stop rule (design doc, "Guardrails" 7): fixes are counted in blocks of
 * 50 in the order they happened, and if more than 10 in a block were
 * reverted, Fix is switched off. It stays off until the owner turns it back
 * on (FIX_OVERRIDE=on), because "until the cause is understood" is a person's
 * call. Never loosen the numbers to let a run through.
 */
export const STOP_RULE = Object.freeze({ blockSize: 50, maxReverted: 10 });

export function fixGate(fixes, { override = null, rule = STOP_RULE } = {}) {
    if (override === 'off') return { enabled: false, reason: 'switched off by the owner' };
    if (override === 'on') return { enabled: true, reason: 'switched on by the owner' };
    for (let i = 0; i < fixes.length; i += rule.blockSize) {
        const block = fixes.slice(i, i + rule.blockSize);
        const reverted = block.filter(f => f.reverted).length;
        if (reverted > rule.maxReverted) {
            return { enabled: false, reason: `${reverted} of fixes ${i + 1}–${i + block.length} were reverted (the limit is ${rule.maxReverted} in ${rule.blockSize})` };
        }
    }
    return { enabled: true, reason: null };
}

/**
 * An event store. With a `file`, events persist across restarts; without
 * one (tests, a quick local run) they live in memory.
 */
export function createStore({ file = null, now = () => new Date() } = {}) {
    const state = createState();
    if (file && existsSync(file)) {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try { applyEvent(state, JSON.parse(line)); } catch { /* a torn last line from a crash */ }
        }
    }
    return {
        state,
        record(event) {
            const e = { at: now().toISOString(), ...event };
            if (file) appendFileSync(file, JSON.stringify(e) + '\n');
            applyEvent(state, e);
            return e;
        },
        card(id) {
            return state.cards.get(id) || emptyCard();
        },
        answered(session) {
            return state.sessions.get(session)?.answered || new Set();
        },
        /** Whether someone other than `session` holds the card right now. */
        heldByOther(id, session, at = now().getTime()) {
            const hold = state.cards.get(id)?.hold;
            return Boolean(hold && hold.until > at && hold.session !== session);
        },
    };
}
