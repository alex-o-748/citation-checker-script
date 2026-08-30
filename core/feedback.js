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

// MediaWiki revision ids are positive integers. Normalising to a number (or
// null) rather than passing whatever the caller had keeps the log column
// numeric, and — because every consumer stringifies the result of this — makes
// the id inert wikitext by construction, with no separate escaping step to
// forget. `wgRevisionId` is 0 on a page that has no revision (a preview, a
// special page), which is not a revision and must not be recorded as one.
export function normalizeRevisionId(value) {
    if (value == null) return null;
    const s = String(value).trim();
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
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
        // The article revision the check ran against. Without it a logged
        // verdict is not reproducible: the page it describes is a moving
        // target, so a disagreement about the verdict can't be separated from
        // an edit to the claim, and two model versions can't be compared
        // because they were never shown the same text.
        revision_id:     normalizeRevisionId(fields.revisionId),
        citation_number: fields.citationNumber ?? null,
        source_url:      fields.sourceUrl ?? null,
        provider:        fields.provider ?? null,
        model:           fields.model ?? null,
        verdict:         fields.verdict ?? null,
        // Sent as `confidence` — not renamed to match `supportScore` — because
        // it must line up with the Neon `verification_logs.confidence` column
        // (see docs/worker-logging-reference.md). Renaming the wire/column
        // name is a separate DB migration; this only renames the internal name.
        confidence:      fields.supportScore ?? null,
        reason_type:     fields.reasonType ?? null,
        // Without these two a thumbs-down is uninterpretable: you know the
        // check was wrong but not what it claimed or why it decided that.
        claim_text:      truncateForLog(fields.claimText),
        llm_comments:    truncateForLog(fields.comments),
        // The passage the model quoted from the source, and the result of
        // checking it against that source (see core/quote.js). Logged
        // together and unconditionally: an unverified quote is exactly the
        // row worth inspecting later, so unlike the UI — which hides it — the
        // log keeps it and lets quote_status say what it is. '' means no
        // quote was offered, which is the correct answer for an omission or
        // an unavailable source.
        source_quote:    truncateForLog(fields.sourceQuote),
        quote_status:    fields.quoteStatus ?? null,
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
// Nothing here emits a signature, and nothing here may. Four tildes are not
// text: they are an instruction to MediaWiki's pre-save transform, which runs
// over the *whole page* on every save, so a preloaded signature belongs to
// whoever saves next rather than to the editor who opened the form. If the
// tildes survive that first save unexpanded — the new topic tool handles
// signing itself — they sit in the page as a landmine until some unrelated
// account saves it and gets its own name and timestamp stamped in. That is
// exactly what happened to check 4d9d0118, which a passing bot signed.
// Signing is the editor's, and their editor's, business; we only ask for it.
//
// The same trap applies to the guidance below, which is why it spells out
// "sign" in words. Literal tildes inside an HTML comment are still expanded by
// the pre-save transform — invisible in the rendered page, and still a
// landmine in the wikitext.
export function buildTalkSectionBody(fields = {}) {
    const {
        articleUrl, articleTitle, citationNumber, claimText, sourceUrl,
        verdict, comments, providerName, model, correctedVerdict, checkId,
        revisionId, revisionUrl,
    } = fields;

    const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
    const label = clean(articleTitle) || clean(articleUrl);
    const toolLines = [];

    if (articleUrl && label) {
        const cite = clean(citationNumber);
        // The revision is what makes the report reproducible, and it belongs
        // on the Article line because it is a property of the article, not of
        // the check: the plain link goes to whatever the page says today, so
        // without the permalink a reader arriving at this section a month
        // later cannot tell whether they are looking at the text the tool
        // read. Linked when the caller supplied a permalink, bare otherwise —
        // the number alone still identifies the revision.
        const rev = normalizeRevisionId(revisionId);
        const revText = rev === null ? '' : (revisionUrl
            ? `[${encodeURI(String(revisionUrl))} ${rev}]`
            : String(rev));
        toolLines.push(`* '''Article:''' [${encodeURI(String(articleUrl))} ${label}]${cite ? `, citation [${cite}]` : ''}${revText ? `, revision ${revText}` : ''}`);
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
        `'''${EDITOR_EXPLANATION_LABEL}:''' <!-- Write your explanation here, then sign and publish. -->`,
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
