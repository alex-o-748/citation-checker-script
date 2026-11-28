// The knowledge check's context for a Fact Hunt card, read from the article's
// wikitext.
//
// The check (core/knowledge-check.js) wants what the uncited-text check gives
// a statement: the article's opening paragraph and the text before the claim
// in its paragraph. ToolsDB stores neither, and the card builder fetches the
// current wikitext, not the rendered HTML, so they are read from that: the
// paragraph holding the claim's search text (find-text.js's offset), turned
// into rough plain text. Rough is enough: it is context so the model knows
// what "It" or "She" refers to, never evidence, and a claim that can't be
// found in its paragraph's plain text gets no context at all
// (knowledgeStatements() never borrows a neighbour's).

// The text with every template ({{...}}, nested) and comment replaced by
// spaces of the same length, newlines kept, so offsets still line up and a
// template spanning blank lines (an infobox) never splits a block.
export function blankTemplates(wikitext) {
    const source = String(wikitext ?? '');
    const chars = source.split('');
    let depth = 0;
    for (let i = 0; i < chars.length; i++) {
        if (source.startsWith('<!--', i)) {
            const end = source.indexOf('-->', i + 4);
            const stop = end < 0 ? chars.length : end + 3;
            for (let j = i; j < stop; j++) if (chars[j] !== '\n') chars[j] = ' ';
            i = stop - 1;
            continue;
        }
        if (source.startsWith('{{', i)) { depth++; chars[i] = ' '; chars[i + 1] = ' '; i++; continue; }
        if (depth > 0 && source.startsWith('}}', i)) { depth--; chars[i] = ' '; chars[i + 1] = ' '; i++; continue; }
        if (depth > 0 && chars[i] !== '\n') chars[i] = ' ';
    }
    return chars.join('');
}

// Strips the wikitext a reader never sees: comments, footnotes, templates,
// files, markup. Links become their label.
export function wikitextToPlain(wikitext) {
    let text = String(wikitext ?? '');
    text = text.replace(/<ref\b[^>]*\/>/gi, '');
    text = text.replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, '');
    text = blankTemplates(text);
    text = text.replace(/\[\[(?:File|Image|Category|Файл|Категория):[^\]]*(?:\[\[[^\]]*\]\][^\]]*)*\]\]/gi, '');
    text = text.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1');
    text = text.replace(/\[(?:https?:)?\/\/[^\s\]]+\s+([^\]]*)\]/g, '$1');
    text = text.replace(/\[(?:https?:)?\/\/[^\s\]]+\]/g, '');
    text = text.replace(/'{2,}/g, '');
    text = text.replace(/<[^>]+>/g, '');
    text = text.replace(/&nbsp;/g, ' ');
    return text.replace(/\s+/g, ' ').replace(/ +([.,;:!?])/g, '$1').trim();
}

// A block of prose: not a heading, table, list or behaviour-switch line.
function isProseBlock(block) {
    const first = block.trim();
    return Boolean(first) && !/^(?:=|\{\||\||!|\*|#|:|;|__)/.test(first);
}

// The paragraphs of a stretch of wikitext, as [start, end) offsets: split at
// blank lines, and a heading line is a block of its own.
function blocksOf(wikitext) {
    const blocks = [];
    let start = 0;
    const lines = wikitext.split('\n');
    let at = 0;
    const close = end => { if (end > start) blocks.push([start, end]); };
    for (const line of lines) {
        const lineEnd = at + line.length;
        if (!line.trim()) {
            close(at);
            start = lineEnd + 1;
        } else if (/^=.*=\s*$/.test(line)) {
            close(at);
            blocks.push([at, lineEnd]);
            start = lineEnd + 1;
        }
        at = lineEnd + 1;
    }
    close(wikitext.length);
    return blocks;
}

/**
 * The plain text of the paragraph holding `offset`, or '' when that block is
 * not prose.
 */
export function paragraphAt(wikitext, offset) {
    const source = String(wikitext ?? '');
    const blanked = blankTemplates(source);
    for (const [start, end] of blocksOf(blanked)) {
        if (offset >= start && offset < end) {
            return isProseBlock(blanked.slice(start, end)) ? wikitextToPlain(source.slice(start, end)) : '';
        }
    }
    return '';
}

/** The article's first prose paragraph before its first heading, as plain text. */
export function openingParagraph(wikitext, { maxChars = 1000 } = {}) {
    const source = String(wikitext ?? '');
    const firstHeading = source.search(/^==[^=]/m);
    const lead = firstHeading < 0 ? source : source.slice(0, firstHeading);
    const blanked = blankTemplates(lead);
    for (const [start, end] of blocksOf(blanked)) {
        if (!isProseBlock(blanked.slice(start, end))) continue;
        const text = wikitextToPlain(lead.slice(start, end));
        if (text.length >= 20) return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
    }
    return '';
}
