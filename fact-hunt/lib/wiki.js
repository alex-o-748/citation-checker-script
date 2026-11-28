// The app's links into Wikipedia, the text it pre-fills there, and the two
// checks it makes afterwards: did the sentence change, and was the fix
// reverted.

export const USER_AGENT = 'fact-hunt (https://github.com/alex-o-748/citation-checker-script)';
export const HASHTAG = '#facthunt';
export const SUMMARY_LIMIT = 500; // MediaWiki's edit summary limit, in characters.

const pageUrl = (host, title) => `https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/').replace(/%3A/g, ':')}`;

export function articleUrl(card) {
    return pageUrl(card.host, card.pageTitle);
}

// A text fragment covering the whole of `text`: its first four words to its
// last four (or all of it, when short). Null when there is nothing to match.
function wholeTextFragment(text) {
    const words = text.trim().split(/\s+/);
    if (words.length < 2) return null;
    const enc = s => encodeURIComponent(s).replace(/-/g, '%2D').replace(/,/g, '%2C').replace(/&/g, '%26');
    return words.length <= 8
        ? enc(words.join(' '))
        : `${enc(words.slice(0, 4).join(' '))},${enc(words.slice(-4).join(' '))}`;
}

/**
 * A text-fragment link that opens the source with the whole quote
 * highlighted — the whole quote, never just the flagged words, so the link
 * shown before an answer doesn't give the answer away. Browsers without text
 * fragments just open the page.
 */
export function sourceLink(card) {
    const fragment = wholeTextFragment(card.quote.text);
    if (!fragment || !/^https?:\/\//i.test(card.sourceUrl)) return card.sourceUrl;
    return `${card.sourceUrl.split('#')[0]}#:~:text=${fragment}`;
}

/**
 * The article, scrolled to the card's sentence with all of it highlighted,
 * for a reader who wants the context around one sentence. The same rule as
 * sourceLink(): the whole sentence, so it gives nothing away before an
 * answer. Where the fragment doesn't match (a citation marker mid-sentence,
 * a sentence since fixed), the article just opens at the top.
 */
export function articleLink(card) {
    const fragment = wholeTextFragment(card.claim.text);
    return fragment ? `${articleUrl(card)}#:~:text=${fragment}` : articleUrl(card);
}

// A few words either side of the flagged words in the quote, so a patroller
// reading the summary sees the source's words in context.
function quoteSnippet(quote, span, wordsEachSide = 4) {
    const before = quote.text.slice(0, span.start).trim().split(/\s+/).filter(Boolean);
    const after = quote.text.slice(span.end).trim().split(/\s+/).filter(Boolean);
    const left = before.slice(-wordsEachSide);
    const right = after.slice(0, wordsEachSide);
    const core = quote.text.slice(span.start, span.end);
    const lead = left.length < before.length ? '…' : '';
    const tail = right.length < after.length ? '…' : '';
    const glueLeft = left.length && !/\s$/.test(quote.text.slice(0, span.start)) ? '' : ' ';
    const glueRight = right.length && !/^\s/.test(quote.text.slice(span.end)) ? '' : ' ';
    return `${lead}${left.join(' ')}${left.length ? glueLeft : ''}${core}${right.length ? glueRight : ''}${right.join(' ')}${tail}`.trim();
}

/**
 * The edit summary for a fix. It quotes the source, because an unexplained
 * change to a number or a date from a new or logged-out account looks like
 * sneaky vandalism; with the source's words in the summary, a patroller can
 * check it without clicking. Carries the hashtag the Hashtags tool indexes.
 */
export function fixSummary(card, { projectPage = null } = {}) {
    const label = card.sourceLabel ? ` (${card.sourceLabel})` : '';
    const tail = ` ${HASHTAG}${projectPage ? ` ([[${projectPage}|what is this?]])` : ''}`;
    let snippet = quoteSnippet(card.quote, card.quote.span);
    let summary = `Corrected to match the cited source${label}: "${snippet}"${tail}`;
    if (summary.length > SUMMARY_LIMIT) {
        snippet = card.quote.text.slice(card.quote.span.start, card.quote.span.end).slice(0, 200);
        summary = `Corrected to match the cited source${label}: "${snippet}"${tail}`.slice(0, SUMMARY_LIMIT);
    }
    return summary;
}

/** The editor, opened at the card's section, with the summary filled in. */
export function editUrl(card, options = {}) {
    const params = new URLSearchParams({ title: card.pageTitle, action: 'edit' });
    if (Number.isInteger(card.section?.index)) params.set('section', String(card.section.index));
    params.set('summary', fixSummary(card, options));
    return `https://${card.host}/w/index.php?${params}`;
}

export function talkTitle(card) {
    const words = card.claim.text.slice(card.claim.span.start, card.claim.span.end);
    return `Possible inaccuracy: "${words}"`;
}

/**
 * The note for the article's talk page: both texts, the source, a question,
 * and a signature. The person posts it themselves.
 */
export function talkNote(card) {
    const source = card.sourceLabel ? `${card.sourceLabel}, ${card.sourceUrl}` : card.sourceUrl;
    return `The article says: "${card.claim.text}" The source cited for it (${source}) says: "${card.quote.text}" Could someone who knows the subject check which is right? ~~~~`;
}

/**
 * A new section on the article's talk page with its heading filled in
 * (`preloadtitle`, which MediaWiki documents for section=new). The body is
 * copied from the app: preloading it needs a template page on the wiki.
 */
export function talkUrl(card) {
    const params = new URLSearchParams({ title: `Talk:${card.pageTitle}`, action: 'edit', section: 'new', preloadtitle: talkTitle(card) });
    return `https://${card.host}/w/index.php?${params}`;
}

/**
 * Has the sentence changed since `sinceIso`? Reads the current wikitext:
 * if the search text (which contains the flagged words) is gone, the
 * sentence was edited. Whoever edited it, the card is fixed.
 *
 * Returns { changed, revisionId, timestamp }.
 */
export async function checkSentence(card, { fetchImpl = fetch } = {}) {
    const params = new URLSearchParams({
        action: 'query', format: 'json', formatversion: '2', redirects: '1',
        prop: 'revisions', rvprop: 'ids|timestamp|content', rvslots: 'main', titles: card.pageTitle,
    });
    const response = await fetchImpl(`https://${card.host}/w/api.php?${params}`, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) throw new Error(`Wikipedia API returned HTTP ${response.status}`);
    const data = await response.json();
    const page = data?.query?.pages?.[0];
    const revision = page?.revisions?.[0];
    if (!page || page.missing || !revision) return { changed: true, revisionId: null, timestamp: null };
    const text = revision.slots?.main?.content ?? '';
    return { changed: !text.includes(card.findText), revisionId: revision.revid, timestamp: revision.timestamp };
}

/**
 * Which of these revisions were reverted. MediaWiki tags a reverted edit
 * `mw-reverted` (undo, rollback, or a manual revert to an earlier text).
 */
export async function revertedRevisions(host, revisionIds, { fetchImpl = fetch } = {}) {
    const reverted = new Set();
    for (let i = 0; i < revisionIds.length; i += 50) {
        const batch = revisionIds.slice(i, i + 50);
        const params = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', prop: 'revisions', rvprop: 'ids|tags', revids: batch.join('|') });
        const response = await fetchImpl(`https://${host}/w/api.php?${params}`, { headers: { 'User-Agent': USER_AGENT } });
        if (!response.ok) throw new Error(`Wikipedia API returned HTTP ${response.status}`);
        const data = await response.json();
        for (const page of data?.query?.pages || []) {
            for (const rev of page.revisions || []) {
                if ((rev.tags || []).includes('mw-reverted')) reverted.add(rev.revid);
            }
        }
    }
    return reverted;
}
