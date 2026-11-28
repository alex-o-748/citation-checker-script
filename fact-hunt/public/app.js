// Fact Hunt: the page. One screen at a time, built with DOM calls (never
// innerHTML with data), talking to the server's small JSON API.

// ---------- Strings: every user-facing string, in one table ----------

const STRINGS = {
    tagline: 'Wikipedia articles sometimes say things their own sources don’t.',
    taglineSub: 'Pick a topic. Catch one. Fix it.',
    chooseTopic: 'Choose a topic',
    surprise: 'Surprise me',
    about: 'About',
    fixedSoFar: '{n} fixed so far',
    latest: 'latest {when}',
    whereDisagree: 'Where do they disagree?',
    tapInstruction: 'Tap the words in Wikipedia’s sentence that the source contradicts.',
    wikipediaSays: 'Wikipedia says',
    sourceSays: 'Its source says',
    readSource: 'Read it in the source',
    same: 'They don’t contradict each other',
    noDifference: 'Can’t find one?',
    skip: 'Skip',
    left: '{n} left',
    warmUp: 'Warm-up: someone already fixed this one. Find what was wrong.',
    warmUpDone: 'That’s the idea. Now a real one.',
    caught: 'You caught it.',
    caughtDetail: 'Wikipedia says {from}. Its source says {to}.',
    readers: 'About {n} people read this article each month.',
    caution: 'Sources can be wrong too. Not sure which is right? Ask the article’s editors.',
    fixIt: 'Fix it on Wikipedia',
    askEditors: 'Ask the article’s editors',
    sharePuzzle: 'Share this puzzle',
    next: 'Next one',
    missTitle: 'Not quite.',
    missDetail: 'We flagged “{from}”. Its source says “{to}”. Does the source contradict that?',
    missYes: 'Yes, that’s wrong',
    missNo: 'No, they match',
    sameTitle: 'Thanks. We’ll take another look.',
    sameDetail: 'We had flagged “{from}” against the source’s “{to}”. Two people saying they don’t contradict each other takes a card out.',
    fixTitle: 'Fix it in three steps',
    fixLede: 'We’ll open the right section of the article in Wikipedia’s editor, in a new tab.',
    stepFind: 'Search the editor for',
    stepChange: 'Correct the marked words',
    stepChangeDetail: 'Make the sentence say what its source says, in your own words.',
    stepPublish: 'Publish',
    stepPublishDetail: 'The edit summary is filled in for you. If it’s empty, paste this:',
    loginTip: 'Have a Wikipedia account? Log in first. No account? You can still edit, or create one.',
    createOne: 'Create an account',
    openEditor: 'Open Wikipedia’s editor',
    comeBack: 'Come back here when you’ve published. We’ll check that it worked.',
    back: 'Back',
    checking: 'Checking the article…',
    notYet: 'We don’t see your edit yet.',
    notYetDetail: 'It can take a minute to show up.',
    published: 'I published it',
    didNot: 'I didn’t',
    fixedTitle: 'Fixed.',
    fixedReaders: 'About {n} people read this article each month. Now it matches its source.',
    fixedNoReaders: 'Now it matches its source.',
    shareIt: 'Share it',
    share: 'Share…',
    copyLink: 'Copy link',
    copied: 'Copied',
    copy: 'Copy',
    tally: 'You: {caught} caught · {fixed} fixed',
    askTitle: 'Ask the article’s editors',
    askLede: 'A note on the article’s talk page reaches the people who watch it. They can check which is right.',
    askStep1: 'Copy this note',
    askStep2: 'Open the talk page, paste it, and publish',
    openTalk: 'Open the talk page',
    posted: 'I posted it',
    askedTitle: 'Thanks. The article’s editors can take it from here.',
    emptyTitle: 'That’s all for now.',
    emptyDetail: 'You’ve seen every card in this topic. Try another one.',
    otherTopics: 'Other topics',
    fixDisabled: 'Fixing is paused while we look into some undone edits. You can still ask the article’s editors.',
    held: 'Someone is fixing this one right now.',
    wikiDown: 'We couldn’t reach Wikipedia to check. Try again in a moment.',
    error: 'Something went wrong. Try again.',
    fixPageTitle: 'Someone fixed this.',
    fixPageDetail: 'Wikipedia’s article said {from}. Its own source said {to}.',
    findOne: 'Find one yourself',
    puzzleBanner: 'Someone shared this sentence. It disagrees with its own source.',
    alreadyFixed: 'This one was fixed already.',
    seeArticle: 'See the article',
    readArticle: 'Read the article',
    aboutTitle: 'About Fact Hunt',
    aboutBody: 'Each card is a sentence from a Wikipedia article and a passage from the source it cites, where a checker found that the two disagree. You decide whether they do. If they do, you fix the article in Wikipedia’s own editor, or ask its editors. Nothing is changed on Wikipedia except by you.',
    aboutPrivacy: 'This site records what you answer, against a random id your browser makes. No account, no tracking, no third-party scripts.',
    mastodonServer: 'Your Mastodon server (for example mastodon.social)',
    never: 'just now',
};

function t(key, vars = {}) {
    const s = STRINGS[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

// ---------- Small helpers ----------

function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'html') throw new Error('no innerHTML');
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const child of children.flat()) {
        if (child == null || child === false) continue;
        el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(paths, size = 18) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
    for (const d of paths) {
        const p = document.createElementNS(SVG_NS, 'path');
        p.setAttribute('d', d);
        svg.append(p);
    }
    return svg;
}
const ICONS = {
    back: ['M15 18l-6-6 6-6'],
    next: ['M5 12h14', 'M13 6l6 6-6 6'],
    out: ['M7 17L17 7', 'M8 7h9v9'],
    share: ['M12 15V3', 'M7 8l5-5 5 5', 'M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6'],
    copy: ['M9 9h11v11H9z', 'M5 15V6a2 2 0 0 1 2-2h9'],
};

const storage = {
    get(key, fallback) {
        try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: keep going */ }
    },
};

function sessionId() {
    let id = storage.get('facthunt.session', null);
    if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^A-Za-z0-9-]/g, '');
        storage.set('facthunt.session', id);
    }
    return id;
}

const SESSION = sessionId();
const memory = { warmedUp: storage.get('facthunt.warmedUp', false), tally: storage.get('facthunt.tally', { caught: 0, fixed: 0, asked: 0 }) };

function bump(key) {
    memory.tally[key] = (memory.tally[key] || 0) + 1;
    storage.set('facthunt.tally', memory.tally);
}

async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(path, {
        method,
        headers: { 'X-Session': SESSION, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await response.json(); } catch { /* empty */ }
    if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status, data });
    return data;
}

const fmt = n => new Intl.NumberFormat('en').format(n);
const ago = iso => {
    const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    if (minutes < 1) return t('never');
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h ago`;
    return `${Math.round(hours / 24)} days ago`;
};

function toast(message) {
    const el = h('div', { class: 'toast', role: 'status' }, message);
    document.body.append(el);
    setTimeout(() => el.remove(), 2200);
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        toast(t('copied'));
    } catch {
        window.prompt(t('copy'), text);
    }
}

const app = document.getElementById('app');
function show(...children) {
    app.replaceChildren(...children.flat().filter(Boolean));
    window.scrollTo(0, 0);
    const heading = app.querySelector('h1');
    if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
}

function go(path) {
    if (location.pathname !== path) history.pushState({}, '', path);
}

// ---------- State ----------

const state = { topics: null, topic: 'any', topicLabel: null, card: null, reveal: null, left: null, tapped: null };

function topicLabel(id) {
    if (id === 'any') return t('surprise');
    return state.topics?.topics.find(x => x.id === id)?.label || id;
}

// ---------- Pieces ----------

function bar({ backTo = 'home', right = null } = {}) {
    const back = backTo === 'home'
        ? h('a', { class: 'back', href: '/', onclick: e => { e.preventDefault(); home(); } }, icon(ICONS.back, 20), state.topic === 'any' ? t('back') : topicLabel(state.topic))
        : h('button', { type: 'button', class: 'back', onclick: backTo }, icon(ICONS.back, 20), t('back'));
    return h('header', { class: 'bar' }, back, right);
}

function wikiPanel(card, { tappable = false, flagSpan = null, tappedIndex = null, onTap = null } = {}) {
    const text = card.claim.text;
    const tokens = card.claim.tokens;
    const sentence = h('p', { class: 'sentence' });
    // Render word by word, keeping each run of non-space characters in one
    // unbreakable chunk, so "Zandig." never leaves its full stop on a line
    // of its own and "(CZW)" keeps its brackets.
    const chunkRe = /\S+|\s+/g;
    let m;
    while ((m = chunkRe.exec(text))) {
        const start = m.index;
        const end = start + m[0].length;
        if (/^\s/.test(m[0])) { sentence.append(m[0]); continue; }
        const chunk = h('span', { class: 'chunk' });
        let cursor = start;
        tokens.forEach((tok, i) => {
            if (tok.start < start || tok.end > end) return;
            if (tok.start > cursor) chunk.append(text.slice(cursor, tok.start));
            const word = text.slice(tok.start, tok.end);
            const flagged = flagSpan && tok.start < flagSpan.end && tok.end > flagSpan.start;
            if (tappable) chunk.append(h('button', { type: 'button', class: `word${tappedIndex === i ? ' tapped' : ''}`, onclick: () => onTap(i) }, word));
            else if (flagged) chunk.append(h('span', { class: 'flag' }, word));
            else chunk.append(word);
            cursor = tok.end;
        });
        if (cursor < end) chunk.append(text.slice(cursor, end));
        sentence.append(chunk);
    }
    return h('section', { class: 'panel wiki', 'aria-label': t('wikipediaSays') },
        // The article's title is the way to its context: quiet, since the
        // sentence is the task, but there for whoever wants more.
        h('div', { class: 'panel-head' }, h('span', { class: 'label' }, t('wikipediaSays')),
            h('a', {
                class: 'quiet article-link', href: card.articleLink || card.articleUrl, target: '_blank', rel: 'noopener noreferrer',
                title: t('readArticle'), onclick: () => recordOpen(card.id, 'article'),
            }, card.pageTitle, icon(ICONS.out, 13))),
        sentence);
}

function sourcePanel(card, { evidenceSpan = null, withLink = true } = {}) {
    const text = card.quote.text;
    const quote = h('p', { class: 'quote' }, '“');
    if (evidenceSpan) {
        quote.append(text.slice(0, evidenceSpan.start), h('mark', { class: 'evidence' }, text.slice(evidenceSpan.start, evidenceSpan.end)), text.slice(evidenceSpan.end));
    } else {
        quote.append(text);
    }
    quote.append('”');
    return h('section', { class: 'panel source', 'aria-label': t('sourceSays') },
        h('div', { class: 'panel-head' }, h('span', { class: 'label' }, t('sourceSays')), h('span', { class: 'quiet' }, card.sourceLabel || '')),
        quote,
        withLink && h('a', { class: 'inline-button', href: card.sourceLink, target: '_blank', rel: 'noopener noreferrer', onclick: () => recordOpen(card.id, 'source') }, t('readSource'), icon(ICONS.out, 16)));
}

function shareBlock({ text, url, kind, cardId }) {
    const area = h('textarea', { class: 'share-text', rows: 5, 'aria-label': t('shareIt') });
    area.value = `${text} ${url}`;
    const record = platform => api('/api/shared', { method: 'POST', body: { card: cardId, kind, platform } }).catch(() => {});
    const open = (href, platform) => { record(platform); window.open(href, '_blank', 'noopener,noreferrer'); };
    const current = () => area.value;
    const buttons = h('div', { class: 'grid-4' },
        h('button', { type: 'button', class: 'small-button', onclick: () => open(`https://bsky.app/intent/compose?text=${encodeURIComponent(current())}`, 'bluesky') }, 'Bluesky'),
        h('button', { type: 'button', class: 'small-button', onclick: () => open(`https://x.com/intent/post?text=${encodeURIComponent(current())}`, 'x') }, 'X'),
        h('button', {
            type: 'button', class: 'small-button', onclick: () => {
                let server = storage.get('facthunt.mastodon', '');
                if (!server) server = (window.prompt(t('mastodonServer')) || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
                if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(server)) return;
                storage.set('facthunt.mastodon', server);
                open(`https://${server}/share?text=${encodeURIComponent(current())}`, 'mastodon');
            },
        }, 'Mastodon'),
        h('button', { type: 'button', class: 'small-button', onclick: () => { record('copy'); copyText(url); } }, t('copyLink')));
    const native = navigator.share
        ? h('button', { type: 'button', class: 'button', onclick: () => { record('native'); navigator.share({ text: current() }).catch(() => {}); } }, icon(ICONS.share), t('share'))
        : null;
    return h('div', { class: 'divider' }, h('h2', { class: 'label' }, t('shareIt')), area, native, buttons);
}

const origin = () => location.origin;

// A link out of the app, recorded on the way: which cards make people want
// more than the one sentence, and whether before or after answering.
function recordOpen(cardId, target) {
    api('/api/opened', { method: 'POST', body: { card: cardId, target } }).catch(() => {});
}

// ---------- Screens ----------

async function home() {
    go('/');
    state.topic = 'any';
    let data;
    try { data = await api('/api/topics'); } catch { return showError(home); }
    state.topics = data;
    const chips = h('div', { class: 'chips' },
        h('button', { type: 'button', class: 'chip primary', onclick: () => startTopic('any') }, t('surprise')),
        data.topics.map(topic => h('button', {
            type: 'button', class: 'chip', disabled: topic.open === 0, onclick: () => startTopic(topic.id),
        }, topic.label, h('span', { class: 'count' }, fmt(topic.open)))));
    const footer = h('footer', { class: 'footer' },
        h('span', { class: 'quiet' }, [t('fixedSoFar', { n: fmt(data.fixed) }), data.latest ? ` · ${t('latest', { when: ago(data.latest.at) })}` : ''].join('')),
        data.latest && h('a', { href: `/f/${data.latest.id}`, onclick: e => { e.preventDefault(); fixPage(data.latest.id); } },
            `${data.latest.pageTitle}: `, h('span', { class: 'flag' }, data.latest.from)));
    show(
        h('header', { class: 'bar' }, h('span', { class: 'wordmark' }, 'fact hunt'), h('a', { class: 'link-quiet', href: '/about', onclick: e => { e.preventDefault(); about(); } }, t('about'))),
        h('h1', { class: 'hero' }, t('tagline')),
        h('p', { class: 'lede' }, t('taglineSub')),
        h('section', { style: 'margin-top: 36px' }, h('h2', { class: 'label' }, t('chooseTopic')), chips),
        h('div', { class: 'spacer' }),
        footer,
    );
}

function about() {
    go('/about');
    show(bar(),
        h('h1', {}, t('aboutTitle')),
        h('p', { class: 'note', style: 'margin-top: 16px' }, t('aboutBody')),
        h('p', { class: 'note muted', style: 'margin-top: 12px' }, t('aboutPrivacy')),
        h('div', { class: 'spacer' }),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'button', onclick: () => home() }, t('chooseTopic'))));
}

async function startTopic(topic) {
    state.topic = topic;
    if (topic !== 'any') go(`/t/${topic}`);
    await nextCard();
}

async function nextCard() {
    let data;
    try {
        const params = new URLSearchParams({ topic: state.topic });
        if (memory.warmedUp) params.set('warmup', 'no');
        data = await api(`/api/next?${params}`);
    } catch { return showError(nextCard); }
    if (!data.card) return empty();
    state.card = data.card;
    state.left = data.left;
    state.reveal = null;
    cardScreen();
}

function cardScreen({ banner = null } = {}) {
    const card = state.card;
    const right = h('div', { class: 'row' },
        state.left != null && h('span', { class: 'quiet' }, t('left', { n: fmt(state.left) })),
        !card.warmUp && h('button', { type: 'button', class: 'link-quiet', onclick: () => answer({ kind: 'skip' }) }, t('skip')));
    show(
        bar({ right }),
        card.warmUp ? h('p', { class: 'banner' }, t('warmUp')) : banner && h('p', { class: 'banner' }, banner),
        h('h1', { style: 'margin-top: 12px' }, t('whereDisagree')),
        h('p', { class: 'lede' }, t('tapInstruction')),
        wikiPanel(card, { tappable: true, onTap: i => { state.tapped = i; answer({ kind: 'tap', token: i }); } }),
        sourcePanel(card),
        h('div', { class: 'spacer' }),
        // The way out, not the main action: tapping a word is. A quiet link,
        // so it never reads as the button to press.
        h('p', { class: 'way-out' }, t('noDifference'), ' ',
            h('button', { type: 'button', class: 'inline-button', onclick: () => answer({ kind: 'same' }) }, t('same'))),
    );
}

async function answer(body) {
    let data;
    try {
        data = await api('/api/answer', { method: 'POST', body: { card: state.card.id, ...body } });
    } catch { return showError(() => cardScreen()); }
    if (data.result === 'skip') return nextCard();
    state.reveal = data;
    if (data.result === 'caught') {
        if (state.card.warmUp) {
            memory.warmedUp = true;
            storage.set('facthunt.warmedUp', true);
        } else {
            bump('caught');
        }
        return caughtScreen();
    }
    if (data.result === 'miss') return missScreen();
    return sameScreen();
}

function missScreen() {
    const { from, to } = state.reveal;
    show(
        bar(),
        h('h1', { style: 'margin-top: 12px' }, t('missTitle')),
        h('p', { class: 'lede' }, t('missDetail', { from, to })),
        wikiPanel(state.card, { flagSpan: state.reveal.claimSpan }),
        sourcePanel(state.card, { evidenceSpan: state.reveal.quoteSpan }),
        h('div', { class: 'spacer' }),
        h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'button', onclick: () => answer({ kind: 'confirm', value: true }) }, t('missYes')),
            h('button', { type: 'button', class: 'button secondary', onclick: () => answer({ kind: 'confirm', value: false }) }, t('missNo'))),
    );
}

function sameScreen() {
    const { from, to } = state.reveal;
    if (state.card.warmUp) { memory.warmedUp = true; storage.set('facthunt.warmedUp', true); }
    show(
        bar(),
        h('h1', { style: 'margin-top: 12px' }, t('sameTitle')),
        h('p', { class: 'lede' }, t('sameDetail', { from, to })),
        wikiPanel(state.card, { flagSpan: state.reveal.claimSpan }),
        sourcePanel(state.card, { evidenceSpan: state.reveal.quoteSpan, withLink: false }),
        h('div', { class: 'spacer' }),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'button', onclick: () => nextCard() }, t('next'), icon(ICONS.next))),
    );
}

function caughtScreen() {
    const card = state.card;
    const r = state.reveal;
    if (card.warmUp) {
        return show(
            bar(),
            h('h1', { style: 'margin-top: 12px' }, t('caught')),
            h('p', { class: 'lede' }, t('caughtDetail', { from: r.from, to: r.to })),
            wikiPanel(card, { flagSpan: r.claimSpan }),
            sourcePanel(card, { evidenceSpan: r.quoteSpan, withLink: false }),
            h('p', { class: 'banner' }, t('warmUpDone')),
            h('div', { class: 'spacer' }),
            h('div', { class: 'actions' }, h('button', { type: 'button', class: 'button', onclick: () => nextCard() }, t('next'), icon(ICONS.next))),
        );
    }
    const shareUrl = `${origin()}/c/${card.id}`;
    show(
        bar({ right: state.left != null && h('span', { class: 'quiet' }, t('left', { n: fmt(Math.max(0, state.left - 1)) })) }),
        h('h1', { style: 'margin-top: 8px' }, t('caught')),
        h('p', { class: 'lede' }, t('caughtDetail', { from: r.from, to: r.to })),
        wikiPanel(card, { flagSpan: r.claimSpan }),
        sourcePanel(card, { evidenceSpan: r.quoteSpan, withLink: false }),
        h('div', { style: 'margin-top: 14px; display: flex; flex-direction: column; gap: 4px' },
            card.monthlyViews != null && h('p', { class: 'note' }, t('readers', { n: fmt(card.monthlyViews) })),
            h('p', { class: 'note muted' }, r.fixEnabled ? t('caution') : t('fixDisabled'))),
        h('div', { class: 'spacer' }),
        h('div', { class: 'actions' },
            r.fixEnabled && h('button', { type: 'button', class: 'button', onclick: () => hold('fix') }, t('fixIt')),
            h('button', { type: 'button', class: `button${r.fixEnabled ? ' secondary' : ''}`, onclick: () => hold('ask') }, t('askEditors')),
            h('div', { class: 'row' },
                h('button', {
                    type: 'button', class: 'inline-button', onclick: () => {
                        const text = 'This Wikipedia sentence disagrees with its own source. Can you spot where?';
                        api('/api/shared', { method: 'POST', body: { card: card.id, kind: 'puzzle', platform: navigator.share ? 'native' : 'copy' } }).catch(() => {});
                        if (navigator.share) navigator.share({ text, url: shareUrl }).catch(() => {});
                        else copyText(`${text} ${shareUrl}`);
                    },
                }, icon(ICONS.share), t('sharePuzzle')),
                h('button', { type: 'button', class: 'inline-button muted', onclick: () => nextCard() }, t('next'), icon(ICONS.next)))),
    );
}

async function hold(action) {
    try {
        await api('/api/hold', { method: 'POST', body: { card: state.card.id, action } });
    } catch (error) {
        if (error.status === 409) { toast(t('held')); return nextCard(); }
        if (error.status === 403) { state.reveal.fixEnabled = false; return caughtScreen(); }
        return showError(() => caughtScreen());
    }
    if (action === 'fix') fixScreen(); else askScreen();
}

function copyBox(text, { serif = false, label }) {
    return h('div', { class: 'copy-box' },
        h('span', { class: `text${serif ? ' serif' : ' small'}` }, text),
        h('button', { type: 'button', class: 'icon-button', 'aria-label': label, onclick: () => copyText(text) }, icon(ICONS.copy, 20)));
}

function step(n, title, ...body) {
    return h('li', { class: 'step' }, h('span', { class: 'step-number', 'aria-hidden': 'true' }, String(n)),
        h('div', { class: 'step-body' }, h('span', { class: 'step-title' }, title), ...body));
}

function fixScreen() {
    const fix = state.reveal.fix;
    const card = state.card;
    show(
        bar({ backTo: () => caughtScreen() }),
        h('h1', { style: 'margin-top: 8px' }, t('fixTitle')),
        h('p', { class: 'lede' }, t('fixLede')),
        h('ol', { class: 'steps' },
            step(1, t('stepFind'), copyBox(fix.findText, { serif: true, label: `${t('copy')}: ${t('stepFind')}` })),
            step(2, t('stepChange'), flaggedSentence(card.claim.text, state.reveal.claimSpan), h('span', { class: 'note muted' }, t('stepChangeDetail'))),
            step(3, t('stepPublish'), h('span', { class: 'note muted' }, t('stepPublishDetail')), copyBox(fix.summary, { label: `${t('copy')}: ${t('stepPublish')}` }))),
        h('p', { class: 'note muted', style: 'margin-top: 22px' }, t('loginTip'), ' ',
            h('a', { href: `https://${new URL(card.articleUrl).host}/wiki/Special:CreateAccount?returnto=${encodeURIComponent(card.pageTitle)}`, target: '_blank', rel: 'noopener noreferrer' }, t('createOne'))),
        h('div', { class: 'spacer' }),
        h('div', { class: 'actions' },
            h('a', { class: 'button', href: fix.editUrl, target: '_blank', rel: 'noopener noreferrer', onclick: () => setTimeout(waitScreen, 300) }, t('openEditor'), icon(ICONS.out)),
            h('p', { class: 'quiet', style: 'margin: 0; text-align: center; line-height: 1.45' }, t('comeBack'))),
    );
}

let checkTimer = null;
function stopChecking() {
    if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
    document.removeEventListener('visibilitychange', onVisible);
}
function onVisible() { if (document.visibilityState === 'visible') checkOnce(); }

async function checkOnce({ keepTrying = 0 } = {}) {
    let data;
    try {
        data = await api('/api/check', { method: 'POST', body: { card: state.card.id } });
    } catch (error) {
        if (error.status === 429) data = { fixed: false };
        else if (error.status === 502) { toast(t('wikiDown')); data = { fixed: false }; }
        else return showError(() => waitScreen());
    }
    if (data.fixed) { stopChecking(); bump('fixed'); return fixedScreen(); }
    if (keepTrying > 0) checkTimer = setTimeout(() => checkOnce({ keepTrying: keepTrying - 1 }), 5000);
    else waitScreen({ notYet: true });
}

function waitScreen({ notYet = false } = {}) {
    document.addEventListener('visibilitychange', onVisible);
    show(
        bar({ backTo: () => { stopChecking(); fixScreen(); } }),
        h('h1', { style: 'margin-top: 8px' }, notYet ? t('notYet') : t('checking')),
        h('p', { class: 'lede' }, notYet ? t('notYetDetail') : t('comeBack')),
        h('div', { class: 'spacer' }),
        h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'button', onclick: () => { waitScreen(); checkOnce({ keepTrying: 12 }); } }, t('published')),
            h('button', { type: 'button', class: 'button secondary', onclick: () => { stopChecking(); caughtScreen(); } }, t('didNot'))),
    );
}

function fixedScreen() {
    const card = state.card;
    const r = state.reveal;
    show(
        bar(),
        h('div', { style: 'margin-top: 12px; display: flex; flex-direction: column; gap: 12px' },
            checkMark(),
            h('h1', {}, t('fixedTitle')),
            flaggedSentence(card.claim.text, r.claimSpan),
            h('p', { class: 'lede' }, card.monthlyViews != null ? t('fixedReaders', { n: fmt(card.monthlyViews) }) : t('fixedNoReaders'))),
        shareBlock({
            text: `Wikipedia’s article on ${card.pageTitle} said ${r.from}. Its own source said ${r.to}. I fixed it. Find one yourself:`,
            url: `${origin()}/f/${card.id}`, kind: 'fix', cardId: card.id,
        }),
        h('div', { class: 'spacer' }),
        h('footer', { class: 'row' },
            h('span', { class: 'quiet' }, t('tally', { caught: memory.tally.caught || 0, fixed: memory.tally.fixed || 0 })),
            h('button', { type: 'button', class: 'inline-button', onclick: () => nextCard() }, t('next'), icon(ICONS.next))),
    );
}

// The sentence with its flagged words marked, and up to eight words before
// them. Only the article's own words: the app never offers replacement text,
// since the source's words dropped into the sentence rarely read as a
// sentence, and text an editor didn't write could fall foul of WP:NOLLM. The
// editor writes the correction.
function flaggedSentence(text, span) {
    const lead = text.slice(0, span.start);
    const words = lead.split(/(?=\s)/);
    const kept = words.slice(-8).join('').replace(/^\s+/, '');
    return h('p', { class: 'sentence', style: 'font-size: 21px; margin: 0' },
        words.length > 8 ? `…${kept}` : kept,
        h('span', { class: 'flag' }, text.slice(span.start, span.end)),
        text.slice(span.end));
}

function checkMark() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({ class: 'check-mark', viewBox: '0 0 52 52', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', 26); c.setAttribute('cy', 26); c.setAttribute('r', 24);
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', 'M15 27l7.5 7.5L37.5 19');
    svg.append(c, p);
    return svg;
}

function askScreen() {
    const ask = state.reveal.ask;
    show(
        bar({ backTo: () => caughtScreen() }),
        h('h1', { style: 'margin-top: 8px' }, t('askTitle')),
        h('p', { class: 'lede' }, t('askLede')),
        h('ol', { class: 'steps' },
            step(1, t('askStep1'), copyBox(ask.note, { label: `${t('copy')}: ${t('askStep1')}` })),
            step(2, t('askStep2'))),
        h('div', { class: 'spacer' }),
        h('div', { class: 'actions' },
            h('a', { class: 'button', href: ask.talkUrl, target: '_blank', rel: 'noopener noreferrer', onclick: () => copyText(ask.note) }, t('openTalk'), icon(ICONS.out)),
            h('button', {
                type: 'button', class: 'button secondary', onclick: async () => {
                    try { await api('/api/asked', { method: 'POST', body: { card: state.card.id } }); } catch { /* the note is on the wiki either way */ }
                    bump('asked');
                    askedScreen();
                },
            }, t('posted'))),
    );
}

function askedScreen() {
    show(
        bar(),
        h('div', { style: 'margin-top: 12px; display: flex; flex-direction: column; gap: 12px' }, checkMark(), h('h1', {}, t('askedTitle'))),
        h('div', { class: 'spacer' }),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'button', onclick: () => nextCard() }, t('next'), icon(ICONS.next))),
    );
}

function empty() {
    const others = (state.topics?.topics || []).filter(x => x.open > 0 && x.id !== state.topic);
    show(
        bar(),
        h('h1', { style: 'margin-top: 12px' }, t('emptyTitle')),
        h('p', { class: 'lede' }, t('emptyDetail')),
        others.length > 0 && h('section', { style: 'margin-top: 24px' }, h('h2', { class: 'label' }, t('otherTopics')),
            h('div', { class: 'chips' }, others.map(x => h('button', { type: 'button', class: 'chip', onclick: () => startTopic(x.id) }, x.label, h('span', { class: 'count' }, fmt(x.open)))))),
    );
}

function showError(retry) {
    show(bar(), h('h1', { style: 'margin-top: 12px' }, t('error')), h('div', { class: 'spacer' }),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'button', onclick: () => retry() }, t('next'))));
}

async function puzzlePage(id) {
    let data;
    try { data = await api(`/api/card/${id}`); } catch { return home(); }
    if (data.status === 'fixed' && data.fixed) return fixPage(id, data);
    if (data.status !== 'open') return home();
    state.card = data.card;
    state.left = null;
    cardScreen({ banner: t('puzzleBanner') });
}

async function fixPage(id, preloaded = null) {
    go(`/f/${id}`);
    let data = preloaded;
    if (!data) {
        try { data = await api(`/api/card/${id}`); } catch { return home(); }
    }
    if (!data.fixed) return home();
    const card = data.card;
    const r = data.fixed;
    show(
        h('header', { class: 'bar' }, h('a', { class: 'wordmark', href: '/', onclick: e => { e.preventDefault(); home(); } }, 'fact hunt')),
        h('div', { style: 'margin-top: 12px; display: flex; flex-direction: column; gap: 12px' },
            checkMark(),
            h('h1', {}, t('fixPageTitle')),
            h('p', { class: 'lede' }, t('fixPageDetail', { from: r.from, to: r.to }))),
        wikiPanel(card, { flagSpan: r.claimSpan }),
        sourcePanel(card, { evidenceSpan: r.quoteSpan }),
        h('p', { style: 'margin-top: 12px' }, h('a', { class: 'inline-button', href: card.articleUrl, target: '_blank', rel: 'noopener noreferrer', onclick: () => recordOpen(card.id, 'article') }, t('seeArticle'), icon(ICONS.out, 16))),
        h('div', { class: 'spacer' }),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'button', onclick: () => home() }, t('findOne'), icon(ICONS.next))),
    );
}

// ---------- Routing ----------

async function route() {
    stopChecking();
    const path = location.pathname;
    let m;
    if ((m = path.match(/^\/t\/([a-z-]+)$/))) {
        if (!state.topics) { try { state.topics = await api('/api/topics'); } catch { /* chips can wait */ } }
        return startTopic(m[1]);
    }
    if ((m = path.match(/^\/c\/([0-9a-f]{12})$/))) return puzzlePage(m[1]);
    if ((m = path.match(/^\/f\/([0-9a-f]{12})$/))) return fixPage(m[1]);
    if (path === '/about') return about();
    return home();
}

window.addEventListener('popstate', route);
route();
