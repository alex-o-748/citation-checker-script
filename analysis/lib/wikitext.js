// Just enough wikitext handling to answer, for one revision, "where is this
// footnote, what prose sits immediately before it, and is it tagged
// {{failed verification}}?" It is not a parser and does not try to render.
//
// Claims in the batch files come from rendered HTML (core/claim.js reads the
// text between citation markers), so they include text that templates
// produce — "{{convert|8|oz|g}}" renders as "8 ounces (230 g)". Stripping
// templates loses some of that. It doesn't matter for change detection: every
// revision is reduced the same way, so an unchanged sentence reduces to the same
// tokens. It only lowers the score used to decide where the claim is, which is
// why that score is a token overlap with a forgiving threshold
// (analysis/lib/match.js), not an exact match.

const ENTITIES = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—',
    minus: '−', thinsp: ' ', ensp: ' ', emsp: ' ', hellip: '…', laquo: '«', raquo: '»',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', times: '×', deg: '°', zwj: '', zwnj: '',
};

export function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
        }
        const named = ENTITIES[body.toLowerCase()];
        return named === undefined ? whole : named;
    });
}

export function stripComments(wikitext) {
    return wikitext.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
}

// Templates whose rendered output is (roughly) one of their own parameters.
// Everything else renders to nothing here — infoboxes, maintenance tags and
// citation templates alike. Kept small on purpose: see the header.
const KEEP_FIRST = new Set([
    'nowrap', 'nobr', 'small', 'smaller', 'big', 'sic', 'abbr', 'ill', 'interlanguage link',
    'em', 'strong', 'var', 'mvar', 'math', 'sub', 'sup', 'not a typo', 'proper name', 'as written',
]);
const KEEP_LAST = new Set(['lang', 'langx', 'transl', 'transliteration']);
const KEEP_POSITIONAL = new Set(['convert', 'cvt']);

function templateName(inner) {
    return inner.split('|')[0].replace(/_/g, ' ').trim().toLowerCase();
}

function positionalParams(inner) {
    return inner.split('|').slice(1).filter(part => !/^\s*[\w -]+\s*=/.test(part)).map(part => part.trim());
}

function renderTemplate(inner) {
    const name = templateName(inner);
    const params = positionalParams(inner);
    if (KEEP_FIRST.has(name)) return params[0] ?? '';
    if (KEEP_LAST.has(name) || name.startsWith('lang-')) return params.at(-1) ?? '';
    if (KEEP_POSITIONAL.has(name)) return params.join(' ');
    return '';
}

/**
 * Removes templates innermost-first, keeping the visible text of the few
 * listed above. Parser functions ({{#if:…}}) and magic words go the same way.
 */
export function stripTemplates(text) {
    let previous;
    let current = text;
    // Innermost: a {{ … }} with no {{ or }} inside it.
    const innermost = /\{\{((?:(?!\{\{|\}\})[\s\S])*)\}\}/g;
    let guard = 0;
    do {
        previous = current;
        current = current.replace(innermost, (_, inner) => renderTemplate(inner));
        guard++;
    } while (current !== previous && guard < 50);
    return current;
}

/**
 * Reduces wikitext prose to plain text. Expects refs already removed (the
 * callers below only ever pass the prose between footnotes).
 */
export function wikitextToPlain(text) {
    let s = stripComments(text);
    s = s.replace(/<ref\b[^>]*\/>/gi, ' ').replace(/<ref\b[^>]*>[\s\S]*?<\/ref\s*>/gi, ' ');
    s = stripTemplates(s);
    // Files and categories render no prose.
    s = s.replace(/\[\[\s*(?:file|image|category|файл|изображение|категория)\s*:[^\[\]]*(?:\[\[[^\]]*\]\][^\[\]]*)*\]\]/gi, ' ');
    s = s.replace(/\[\[([^\[\]|]*)\|([^\[\]]*)\]\]/g, '$2');
    s = s.replace(/\[\[([^\[\]]*)\]\]/g, '$1');
    s = s.replace(/\[(?:https?:)?\/\/[^\s\]]+\s+([^\]]*)\]/g, '$1');
    s = s.replace(/\[(?:https?:)?\/\/[^\s\]]+\]/g, ' ');
    s = s.replace(/'{2,}/g, '');
    s = s.replace(/<br\s*\/?>/gi, ' ');
    s = s.replace(/<\/?[a-z][^>]*>/gi, ' ');
    s = s.replace(/^[*#:;]+/gm, ' ').replace(/^=+\s*(.*?)\s*=+\s*$/gm, '$1');
    s = s.replace(/^\{\||^\|\}|^\|-.*$/gm, ' ').replace(/\|\||!!/g, ' ');
    return decodeEntities(s);
}

// Templates editors use to say "this source doesn't back this". The
// {{failed verification}} family plus the near relatives an editor reaches for
// when the source is the problem rather than the claim. Redirects included,
// because the bare template names are what appear in wikitext.
export const FLAG_TEMPLATES = {
    enwiki: [
        'failed verification', 'fv', 'verification failed', 'not in citation given', 'not in ref',
        'nicg', 'failed verification span', 'fvs', 'not in source', 'source does not support',
        'better source needed', 'better source', 'bsn', 'unreliable source?', 'unreliable source',
        'dubious', 'disputed inline', 'verify source', 'verify quote', 'request quotation', 'rq',
        'page needed', 'citation needed', 'cn', 'fact', 'additional citation needed',
        'self-published inline', 'third-party inline', 'irrelevant citation', 'unreliable medical source',
    ],
    ruwiki: [
        'нет в источнике', 'проверено', 'не проверено', 'неавторитетный источник', 'нет аи', 'нет аи 2',
        'источник?', 'нет источника', 'подтвердить', 'уточнить', 'sfn-unverified', 'нет страницы',
    ],
};

// Matches a template call at the very start of `text`, returning its name
// (lower-cased, normalised) or null.
function leadingTemplateName(text) {
    const m = /^\{\{\s*([^{}|]+?)\s*(?:\||\}\})/.exec(text);
    return m ? m[1].replace(/_/g, ' ').trim().toLowerCase() : null;
}

function skipBalancedTemplate(text, start) {
    let depth = 0;
    for (let i = start; i < text.length - 1; i++) {
        if (text[i] === '{' && text[i + 1] === '{') { depth++; i++; } else if (text[i] === '}' && text[i + 1] === '}') {
            depth--; i++;
            if (depth === 0) return i + 1;
        }
    }
    return text.length;
}

/**
 * Footnote markers in document order: <ref>…</ref>, <ref …/>, and the
 * short-citation templates that also produce a footnote ({{sfn}}, {{r}}, …).
 *
 * Each marker carries:
 *   start/end   offsets in the comment-stripped text (`text` on the result)
 *   name        <ref name=…> or null
 *   body        the ref's own content ('' for a reuse)
 *   raw         the marker's wikitext, to compare across revisions
 *   kind        'ref' | 'template'
 */
const SHORT_CITE_TEMPLATES = new Set(['sfn', 'sfnp', 'sfnm', 'harvnb', 'r', 'rp', 'efn', 'refn', 'ref label', 'snf']);

export function parseFootnotes(wikitext) {
    const text = stripComments(wikitext);
    const markers = [];
    const refRe = /<ref\b([^>]*?)(\/>|>([\s\S]*?)<\/ref\s*>)/gi;
    let m;
    while ((m = refRe.exec(text))) {
        const attrs = m[1] || '';
        const nameMatch = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'/>]+))/i.exec(attrs);
        const name = nameMatch ? decodeEntities((nameMatch[1] ?? nameMatch[2] ?? nameMatch[3]).trim()) : null;
        markers.push({ start: m.index, end: m.index + m[0].length, name, body: m[3] ?? '', raw: m[0], kind: 'ref' });
    }
    // Short-citation templates outside refs.
    for (let i = text.indexOf('{{'); i !== -1; i = text.indexOf('{{', i + 2)) {
        const name = leadingTemplateName(text.slice(i));
        if (!name || !SHORT_CITE_TEMPLATES.has(name)) continue;
        if (markers.some(r => r.kind === 'ref' && i >= r.start && i < r.end)) continue;
        const end = skipBalancedTemplate(text, i);
        markers.push({ start: i, end, name: null, body: text.slice(i, end), raw: text.slice(i, end), kind: 'template' });
    }
    markers.sort((a, b) => a.start - b.start);

    // A named reuse (<ref name=x/>) carries no body; its source lives in the
    // definition, which may be elsewhere in prose or inside {{reflist|refs=}}.
    const definitions = new Map();
    for (const marker of markers) {
        if (marker.name && marker.body.trim() && !definitions.has(marker.name)) definitions.set(marker.name, marker.body);
    }
    for (const marker of markers) marker.definition = marker.name ? (definitions.get(marker.name) ?? marker.body) : marker.body;

    return { text, markers };
}

/**
 * The prose a footnote is attached to: from the previous footnote (or the
 * start of the line) up to this one, skipping over directly adjacent footnotes
 * so that every marker in a group "[6][7]" gets the group's sentence.
 */
export function precedingProse(parsed, index) {
    const { text, markers } = parsed;
    let first = index;
    while (first > 0 && /^\s*$/.test(text.slice(markers[first - 1].end, markers[first].start))) first--;
    const end = markers[first].start;
    const lineStart = text.lastIndexOf('\n', end - 1) + 1;
    const previousEnd = first > 0 ? markers[first - 1].end : 0;
    return text.slice(Math.max(lineStart, previousEnd), end);
}

/**
 * Flag templates ({{failed verification}} and relatives) attached directly to
 * a footnote: the run of templates, other footnotes and whitespace that
 * immediately follows it, which is where those templates are placed.
 */
export function flagsAfter(parsed, index, wiki = 'enwiki') {
    const names = new Set(FLAG_TEMPLATES[wiki] ?? FLAG_TEMPLATES.enwiki);
    const { text, markers } = parsed;
    const found = [];
    let i = markers[index].end;
    for (let steps = 0; steps < 20 && i < text.length; steps++) {
        const ws = /^\s*/.exec(text.slice(i))[0].length;
        if (ws && /\n/.test(text.slice(i, i + ws))) break;
        i += ws;
        const next = markers.find(marker => marker.start === i);
        if (next) { i = next.end; continue; }
        if (text.startsWith('{{', i)) {
            const name = leadingTemplateName(text.slice(i));
            const end = skipBalancedTemplate(text, i);
            if (name && names.has(name)) found.push(name);
            i = end;
            continue;
        }
        break;
    }
    return found;
}

/**
 * The footnotes cited together with marker `index`: the run of markers around
 * it separated only by whitespace and templates ({{failed verification}},
 * {{rp|…}}, …). An editor fixing a citation often adds a second source next
 * to the first rather than touching it; this is how that shows up.
 */
export function footnoteCluster(parsed, index) {
    const { text, markers } = parsed;
    const joins = (a, b) => isGlue(text.slice(markers[a].end, markers[b].start));
    let first = index;
    while (first > 0 && joins(first - 1, first)) first--;
    let last = index;
    while (last < markers.length - 1 && joins(last, last + 1)) last++;
    const out = [];
    for (let i = first; i <= last; i++) out.push(i);
    return out;
}

function isGlue(between) {
    let i = 0;
    while (i < between.length) {
        if (/\s/.test(between[i]) && between[i] !== '\n') { i++; continue; }
        if (between.startsWith('{{', i)) { i = skipBalancedTemplate(between, i); continue; }
        return false;
    }
    return true;
}

/**
 * What a footnote cites, stable under the edits bots make to citations
 * (access-date, archive-url, url-status, reformatting): its ref name together
 * with the URLs its definition cites, so a named ref whose URL is swapped
 * reads as a different source; for a ref with no URL, its text without those
 * fields.
 */
export function footnoteKey(marker, citedUrls) {
    const body = decodeEntities(marker.definition || marker.body || marker.raw);
    const urls = [...citedUrls(body)].sort();
    const name = marker.name ? `name:${marker.name}` : '';
    if (urls.length) return `${name}${name ? ' ' : ''}url:${urls.join(' ')}`;
    if (name) return name;
    return `text:${body
        .replace(/\|\s*(?:access-?date|archive-?url|archive-?date|url-?status|df|mode)\s*=[^|}]*/gi, '')
        .replace(/\s+/g, ' ').trim().toLowerCase()}`;
}
