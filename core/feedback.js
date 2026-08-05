// Feedback helpers: the check identifier and the verification-log payload.
//
// Every verification mints a short `check_id` client-side, at the moment the
// verdict is parsed. Client-side rather than server-assigned so that logging
// stays fire-and-forget — nothing has to await a round trip before the
// feedback controls attached to a result become usable, and the id still
// exists if the log write failed outright.
//
// The id is what lets a later rating or talk-page comment point back at the
// exact check it is about. Collision risk is 32 bits against a low-volume,
// human-paced event stream; a duplicate would mean one rating attaches to the
// wrong row, which is not worth a longer id in the UI or the section heading.
//
// Inlined into main.js between <core-injected> markers, and importable from
// tests.

// Where comments go. Deliberately the script's main talk page rather than a
// dedicated feedback subpage: volume is low, it is the address already
// advertised in the report footer, and concentrating discussion is worth more
// than tidiness. If it ever gets noisy, archiving is a bot config change
// rather than a redesign.
export const FEEDBACK_TALK_PAGE = 'User talk:Alaexis/AI_Source_Verification';

// A one-line page whose entire content is `$1`. It exists only because
// MediaWiki will not accept body text directly in an edit URL; see
// buildCommentUrl(). Nothing about it needs to change when the section layout
// does.
export const FEEDBACK_PRELOAD_PAGE = 'User:Alaexis/AI_Source_Verification/feedback-preload';

// Claim text and LLM rationale are unbounded in principle — a pathological
// source or a runaway model response shouldn't push a multi-megabyte row into
// the log table. Both are stored for interpretation, not verbatim archival.
export const MAX_LOGGED_TEXT = 2000;

export function truncateForLog(value, max = MAX_LOGGED_TEXT) {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s) return null;
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// 8 hex characters. `source` is injectable so tests can pin the output;
// production passes nothing and picks up the ambient Web Crypto.
export function newCheckId(source) {
    const c = source ?? (typeof crypto !== 'undefined' ? crypto : null);
    if (c && typeof c.randomUUID === 'function') {
        return c.randomUUID().replace(/-/g, '').slice(0, 8);
    }
    if (c && typeof c.getRandomValues === 'function') {
        const buf = c.getRandomValues(new Uint8Array(4));
        return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
    }
    // Neither API available (very old browser, exotic sandbox). Ratings and
    // comments still work; ids are merely less uniformly distributed.
    return Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
}

// Shapes the POST /log body. Field names are snake_case to match the Neon
// columns directly, so the worker can insert without a translation layer.
export function buildLogPayload(fields = {}) {
    return {
        check_id:        fields.checkId ?? null,
        // 'source' for a single citation, 'group' for the collective verdict
        // over an adjacent-citation group. Without it a group row is
        // indistinguishable from a solo row whose source couldn't be fetched:
        // both carry a null source_url.
        kind:            fields.kind ?? 'source',
        article_url:     fields.articleUrl ?? null,
        article_title:   fields.articleTitle ?? null,
        citation_number: fields.citationNumber ?? null,
        source_url:      fields.sourceUrl ?? null,
        provider:        fields.provider ?? null,
        model:           fields.model ?? null,
        verdict:         fields.verdict ?? null,
        confidence:      fields.confidence ?? null,
        reason_type:     fields.reasonType ?? null,
        // Without these two a thumbs-down is uninterpretable: you know the
        // check was wrong but not what it claimed or why it decided that.
        claim_text:      truncateForLog(fields.claimText),
        llm_comments:    truncateForLog(fields.comments),
    };
}

// Shapes the POST /feedback body. A row may carry a rating, a corrected
// verdict, a pointer to a talk-page section, or any combination — the comment
// flow sends a wiki_section with no rating, the thumbs send a rating with no
// section, and a thumbs-down that then gets commented on sends both.
//
// No username: the sidebar promises that results are logged without recording
// who ran them, and a rating is part of that promise. A talk-page comment is
// signed, but that signature lives on the wiki, not in this table.
export function buildFeedbackPayload(fields = {}) {
    return {
        check_id:          fields.checkId ?? null,
        rating:            fields.rating ?? null,
        corrected_verdict: fields.correctedVerdict ?? null,
        wiki_section:      fields.wikiSection ?? null,
        // Random per-browser token from localStorage. Dedupes repeat clicks
        // and gives a rough distinct-user count; it is not derived from
        // anything about the user.
        client_id:         fields.clientId ?? null,
    };
}

// Wraps machine-inserted text so it can't be read as wikitext. Whitespace is
// collapsed because these land inline in a bullet list.
export function nowikiWrap(text) {
    const s = String(text ?? '')
        .replace(/<\s*\/?\s*nowiki\s*\/?\s*>/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    return s ? `<nowiki>${s}</nowiki>` : '';
}

// MediaWiki titles cannot contain = < > [ ] { } | # _, so an article title is
// already safe to drop into a heading; collapsing whitespace is enough. The
// citation number comes from DOM text, so it gets filtered.
export function buildTalkSectionTitle({ articleTitle, citationNumber, checkId } = {}) {
    const title = String(articleTitle ?? '').replace(/\s+/g, ' ').trim() || 'Unknown article';
    const num = String(citationNumber ?? '').replace(/[^\w.,\s-]/g, '').replace(/\s+/g, ' ').trim();
    return `Feedback: ${title}${num ? ` [${num}]` : ''} (check ${checkId ?? 'unknown'})`;
}

// Title of the collapsed box holding the tool's own output, and the label
// introducing the editor's prose. Exported because they are the seam between
// this layout and anything reading it back — the talk-page scraper tells
// machine context from human text by these two strings.
export const CHECK_DETAILS_TITLE = 'Check details';
export const EDITOR_EXPLANATION_LABEL = "Editor's explanation";

// A talk-page section, split by who wrote what: everything the tool produced
// is collapsed behind {{hidden begin}}, and everything the editor supplies —
// the corrected verdict and their explanation — stays visible. A reader
// scanning the talk page sees the human argument; the machine context is one
// click away when they want to check it.
//
// The begin/end template pair is deliberate. {{collapse|...}} would make the
// bullets a template *parameter*, where a stray | or = in a source URL
// silently truncates the box; as body text between two templates they are
// inert. {{cot}}/{{cob}} is also wrong here — it renders "the following
// discussion is closed", and this was never a discussion.
//
// It is preloaded into Wikipedia's own new section form rather than posted by
// the script, so this text is a starting point the editor sees and can
// change, not a finished comment.
//
// The check id appears twice on purpose: in the heading, where a human reading
// the talk page can see which check is under discussion, and in a trailing
// HTML comment, which is what the talk-page scraper can match on without
// having to parse headings. HTML comments are also how the "write here"
// guidance is delivered — visible in the edit box, invisible once published.
//
// The signature stays last (bar that invisible comment) because DiscussionTools
// attributes a comment by the signature that ends it; content after it lands
// the reply button in the wrong place.
export function buildTalkSectionBody(fields = {}) {
    const {
        articleUrl, articleTitle, citationNumber, claimText, sourceUrl,
        verdict, comments, providerName, model, correctedVerdict, checkId,
    } = fields;

    const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
    const label = clean(articleTitle) || clean(articleUrl);
    const toolLines = [];

    if (articleUrl && label) {
        const cite = clean(citationNumber);
        toolLines.push(`* '''Article:''' [${encodeURI(String(articleUrl))} ${label}]${cite ? `, citation [${cite}]` : ''}`);
    }
    if (sourceUrl) {
        // encodeURI neutralises {{ }} (the one wikitext construct a citation
        // URL could plausibly smuggle in) while leaving the link clickable.
        toolLines.push(`* '''Source:''' ${encodeURI(String(sourceUrl))}`);
    }
    if (verdict) {
        const by = [clean(providerName), clean(model)].filter(Boolean).join(', ');
        toolLines.push(`* '''Tool's verdict:''' ${clean(verdict)}${by ? ` (${by})` : ''}`);
    }
    const claim = nowikiWrap(claimText);
    if (claim) toolLines.push(`* '''Claim checked:''' ${claim}`);
    const reasoning = nowikiWrap(comments);
    if (reasoning) toolLines.push(`* '''Tool's reasoning:''' ${reasoning}`);

    const blocks = [];

    if (toolLines.length) {
        blocks.push([
            `{{hidden begin|title=${CHECK_DETAILS_TITLE}}}`,
            ...toolLines,
            '{{hidden end}}',
        ].join('\n'));
    }
    // The editor's, not the tool's, so it stays outside the box — on a
    // thumbs-down this line is the disagreement itself, and burying it would
    // leave the visible section saying nothing.
    if (correctedVerdict) {
        blocks.push(`'''Editor says it should be:''' ${clean(correctedVerdict)}`);
    }
    // Label and guidance share a line so that writing at the obvious spot —
    // after the invisible comment — renders as "Editor's explanation: <prose>"
    // rather than leaving a bold heading dangling above the text.
    blocks.push(
        `'''${EDITOR_EXPLANATION_LABEL}:''' <!-- Write your explanation here, then publish. -->`,
        '~~~~',
        `<!-- source-verifier check: ${checkId ?? 'unknown'} -->`,
    );

    return blocks.join('\n\n');
}

// The URL that opens Wikipedia's own "add new section" form with the context
// already in the edit box.
//
// A URL can name the page and set the heading, but there is no parameter for
// body text — hence preload, which starts the edit box off with the contents
// of another page, substituting $1, $2… from preloadparams. FEEDBACK_PRELOAD_PAGE
// contains nothing but `$1`, so the whole body travels as one parameter and
// buildTalkSectionBody stays the only place the layout is defined. That page
// never needs to change.
export function buildCommentUrl(fields = {}, {
    wikiBase = 'https://en.wikipedia.org/w/index.php',
    talkPage = FEEDBACK_TALK_PAGE,
    preloadPage = FEEDBACK_PRELOAD_PAGE,
} = {}) {
    const params = new URLSearchParams();
    params.set('title', talkPage);
    params.set('action', 'edit');
    params.set('section', 'new');
    params.set('preloadtitle', buildTalkSectionTitle(fields));
    params.set('preload', preloadPage);
    params.set('preloadparams[]', buildTalkSectionBody(fields));
    return `${wikiBase}?${params.toString()}`;
}
