// Link preview images (1200×630), drawn as SVG and rendered to PNG on the
// server, because Bluesky and X don't show SVG previews.
//
// PNG rendering uses @resvg/resvg-js, an optional dependency. Without it the
// pages simply carry no og:image, and links unfurl as text.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const WIDTH = 1200;
export const HEIGHT = 630;

const INK = '#15171C';
const MUTED = '#5C6370';
const ERROR = '#C2321F';
const SERIF = "'Source Serif 4', 'Source Serif Pro', 'DejaVu Serif', Georgia, serif";
const SANS = "Inter, 'DejaVu Sans', Helvetica, Arial, sans-serif";

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Greedy line wrap by an estimated character width (no font metrics on the
 * server). Each line is a list of { text, mark } runs, so a marked word keeps
 * its colour across a wrap. `maxLines` clips with an ellipsis.
 */
export function wrapRuns(runs, { maxChars, maxLines = Infinity }) {
    const words = [];
    for (const run of runs) {
        for (const piece of run.text.split(/(\s+)/)) {
            if (!piece) continue;
            if (/^\s+$/.test(piece)) words.push({ space: true });
            else words.push({ text: piece, mark: run.mark || null });
        }
    }
    const lines = [];
    let line = [];
    let length = 0;
    let pendingSpace = false;
    for (const w of words) {
        if (w.space) { pendingSpace = line.length > 0; continue; }
        if (line.length && length + (pendingSpace ? 1 : 0) + w.text.length > maxChars) {
            lines.push(line);
            line = [];
            length = 0;
        }
        const last = line[line.length - 1];
        // A space between words goes into the unmarked run, so a strike-
        // through or highlight never runs on past its word.
        const space = pendingSpace && line.length ? ' ' : '';
        if (space) length += 1;
        if (last && last.mark === w.mark) last.text += space + w.text;
        else if (space && !last.mark) { last.text += space; line.push({ text: w.text, mark: w.mark }); }
        else line.push({ text: space + w.text, mark: w.mark });
        length += w.text.length;
        pendingSpace = false;
    }
    if (line.length) lines.push(line);
    if (lines.length > maxLines) {
        const kept = lines.slice(0, maxLines);
        const tail = kept[kept.length - 1];
        tail[tail.length - 1].text = tail[tail.length - 1].text.replace(/\s*\S*$/, '') + '…';
        return kept;
    }
    return lines;
}

/** The flagged words with a few words of context either side. */
export function contextRuns(text, span, wordsEachSide = 7) {
    const before = text.slice(0, span.start);
    const after = text.slice(span.end);
    const beforeWords = before.split(/(?=\s)/);
    const afterWords = after.split(/(?<=\s)/);
    const left = beforeWords.slice(-wordsEachSide).join('');
    const right = afterWords.slice(0, wordsEachSide).join('');
    return [
        { text: (beforeWords.length > wordsEachSide ? '…' : '') + left.replace(/^\s+/, '') },
        { text: text.slice(span.start, span.end), mark: 'flag' },
        { text: right.replace(/\s+$/, '') + (afterWords.length > wordsEachSide ? '…' : '') },
    ].filter(r => r.text);
}

function textBlock(lines, { x, y, size, lineHeight, family, weight = 400, marks = {} }) {
    return lines.map((line, i) => {
        const spans = line.map(run => {
            const style = run.mark ? marks[run.mark] || '' : '';
            return `<tspan${style}>${esc(run.text)}</tspan>`;
        }).join('');
        return `<text x="${x}" y="${y + i * lineHeight}" font-family="${esc(family)}" font-size="${size}" font-weight="${weight}" fill="${INK}" xml:space="preserve">${spans}</text>`;
    }).join('\n');
}

function frame(inner, { corner }) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<rect width="${WIDTH}" height="${HEIGHT}" fill="#FFFFFF"/>
<text x="72" y="96" font-family="${esc(SANS)}" font-size="30" font-weight="600" fill="${INK}">fact hunt</text>
<path d="M72 110 q 6 -6 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0" fill="none" stroke="${ERROR}" stroke-width="2.5"/>
${corner}
${inner}
</svg>`;
}

/** The preview for a fix: what Wikipedia said, what its source says, "Fixed". */
export function fixSvg(card) {
    const claimLines = wrapRuns(contextRuns(card.claim.text, card.claim.span), { maxChars: 42, maxLines: 2 });
    const quoteLines = wrapRuns(contextRuns(card.quote.text, card.quote.span), { maxChars: 52, maxLines: 2 });
    const corner = `<rect x="${WIDTH - 72 - 150}" y="58" width="150" height="54" rx="27" fill="none" stroke="${INK}" stroke-width="2.5"/>
<path d="M${WIDTH - 72 - 150 + 26} 86 l 9 9 l 18 -20" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
<text x="${WIDTH - 72 - 150 + 62}" y="95" font-family="${esc(SANS)}" font-size="24" font-weight="600" fill="${INK}">Fixed</text>`;
    const inner = `
<text x="72" y="196" font-family="${esc(SANS)}" font-size="22" font-weight="600" fill="${MUTED}">Wikipedia said</text>
${textBlock(claimLines, { x: 72, y: 254, size: 46, lineHeight: 58, family: SERIF, marks: { flag: ` fill="${ERROR}" font-weight="600" text-decoration="line-through"` } })}
<text x="72" y="${254 + claimLines.length * 58 + 34}" font-family="${esc(SANS)}" font-size="22" font-weight="600" fill="${MUTED}">Its source says</text>
${textBlock(quoteLines, { x: 72, y: 254 + claimLines.length * 58 + 86, size: 38, lineHeight: 50, family: SERIF, marks: { flag: ' font-weight="700"' } })}
<text x="72" y="${HEIGHT - 56}" font-family="${esc(SANS)}" font-size="22" fill="${MUTED}">${esc(card.pageTitle)}${card.sourceLabel ? ` · source: ${esc(card.sourceLabel)}` : ''}</text>
<text x="${WIDTH - 72}" y="${HEIGHT - 56}" text-anchor="end" font-family="${esc(SANS)}" font-size="22" font-weight="600" fill="${INK}">Find one yourself →</text>`;
    return frame(inner, { corner });
}

/** The preview for a puzzle: the sentence, with no answer in it. */
export function puzzleSvg(card) {
    const lines = wrapRuns([{ text: card.claim.text }], { maxChars: 50, maxLines: 4 });
    const boxHeight = lines.length * 52 + 48;
    const corner = `<text x="${WIDTH - 72}" y="96" text-anchor="end" font-family="${esc(SANS)}" font-size="22" fill="${MUTED}">${esc(card.pageTitle)}</text>`;
    const inner = `
<text x="72" y="190" font-family="${esc(SANS)}" font-size="26" font-weight="500" fill="${MUTED}">This Wikipedia sentence disagrees with its own source.</text>
<text x="72" y="252" font-family="${esc(SANS)}" font-size="54" font-weight="700" fill="${INK}">Can you spot where?</text>
<rect x="72" y="290" width="${WIDTH - 144}" height="${boxHeight}" rx="20" fill="#F4F5F7"/>
${textBlock(lines, { x: 104, y: 290 + 62, size: 38, lineHeight: 52, family: SERIF })}
<text x="${WIDTH - 72}" y="${HEIGHT - 48}" text-anchor="end" font-family="${esc(SANS)}" font-size="22" font-weight="600" fill="${INK}">Tap to check →</text>`;
    return frame(inner, { corner });
}

let resvgModule;
async function loadResvg() {
    if (resvgModule === undefined) {
        try { resvgModule = await import('@resvg/resvg-js'); } catch { resvgModule = null; }
    }
    return resvgModule;
}

export async function pngAvailable() {
    return Boolean(await loadResvg());
}

function fontFiles(dir) {
    if (!dir) return [];
    try {
        return readdirSync(dir).filter(f => /\.(ttf|otf)$/i.test(f)).map(f => join(dir, f));
    } catch {
        return [];
    }
}

/** PNG bytes for an SVG, or null when resvg isn't installed. */
export async function renderPng(svg, { fontDir = null } = {}) {
    const mod = await loadResvg();
    if (!mod) return null;
    const resvg = new mod.Resvg(svg, {
        fitTo: { mode: 'width', value: WIDTH },
        font: { loadSystemFonts: true, fontFiles: fontFiles(fontDir), defaultFontFamily: 'DejaVu Sans' },
        background: '#FFFFFF',
    });
    return resvg.render().asPng();
}

