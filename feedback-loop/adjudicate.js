// An independent second reading of a rated check, and the label it implies.
//
// Two model calls, deliberately separated:
//
//   1. BLIND. The adjudicator sees the claim and the re-fetched source, and
//      nothing else: not the tool's verdict, not the editor's. Its verdict is
//      therefore independent of both, which is what makes agreement with the
//      editor worth something. Its evidence quote is checked against the
//      source with core/quote.js, so the passage it relies on provably exists.
//   2. ATTRIBUTION. Only when someone disagrees. Sees everything — the tool's
//      output, the editor's feedback, the blind reading and the pattern hints —
//      and names the cause, from the vocabulary of
//      docs/design-plans/2026-11-08-fixable-causes-of-disputed-verdicts.md.
//      It is not given the source again: the blind reading already reports
//      what the source says, and a second copy of up to 100k characters per
//      case would double the cost for little gain.
//
// The label itself is decided here, in code (proposeLabel), never by a model:
// a label is "agreed" only when the editor and the blind reading arrive at the
// same verdict independently and the evidence verifies. Everything else is
// left for the owner, with the reasons spelled out.
//
// The rubric is docs/verification-framework.md's, condensed. One addition is
// marked below (the source's URL counts as evidence of who published it); it
// is the brief's cause 1 and the owner can drop the line.

import { canonicalizeVerdict, toTitleCase, VERDICT_LIST } from '../core/verdicts.js';
import { verifyQuote, quoteExpectedFor } from '../core/quote.js';
import { causeRule } from './causes.js';

// Bump when either prompt changes. Stored on every adjudicated row, so labels
// made under different prompts can be told apart later.
export const ADJUDICATOR_VERSION = 'adj-v1';

export const ATTRIBUTION_CAUSES = Object.freeze({
    TOOL_CORRECT: 'tool_correct',
    MISSED_EVIDENCE: 'missed_evidence',
    CITATION_METADATA: 'citation_metadata',
    UNUSABLE_PAGE: 'unusable_page',
    READABLE_CALLED_UNAVAILABLE: 'readable_called_unavailable',
    VERDICT_INCONSISTENT: 'verdict_inconsistent',
    TOO_LITERAL: 'too_literal',
    CLAIM_SCOPE: 'claim_scope',
    EVIDENCE_NOT_FETCHED: 'evidence_not_fetched',
    RUBRIC_QUESTION: 'rubric_question',
    EDITOR_LIKELY_WRONG: 'editor_likely_wrong',
    OTHER: 'other',
});

// Which cause in the 2026-11-08 brief each attribution belongs to, for
// grouping the triage report. null: not one of the five.
export const CAUSE_BRIEF_SECTION = Object.freeze({
    tool_correct: null,
    citation_metadata: 1,
    unusable_page: 2,
    readable_called_unavailable: 2,
    verdict_inconsistent: 3,
    too_literal: 3,
    missed_evidence: 4,
    claim_scope: 5,
    evidence_not_fetched: null,
    rubric_question: null,
    editor_likely_wrong: null,
    other: null,
});

export const ATTRIBUTION_DESCRIPTIONS = Object.freeze({
    tool_correct: "the checker's verdict was right.",
    missed_evidence: 'the source contains the passage that decides the verdict, and the checker did not find or credit it.',
    citation_metadata: "what the checker said was missing is the source's own identity or date (publisher, author, dateline), which its URL or the text's dateline establishes.",
    unusable_page: 'the retrieved text is not the cited work (login page, catalogue record, landing page, bot check, JavaScript shell), and the checker judged the claim against it anyway.',
    readable_called_unavailable: 'the retrieved text is a readable document, and the checker called it unavailable instead of judging the claim.',
    verdict_inconsistent: "the checker's own explanation supports a different verdict from the one it gave (for example \"confirms X but not Y\" with NOT SUPPORTED).",
    too_literal: "the checker rejected a paraphrase or a straightforward implication, or demanded the claim's exact wording.",
    claim_scope: 'the claim text includes sentences the citation does not cover, or is a fragment (a table cell, list item or infobox value) that cannot be judged without its row or label.',
    evidence_not_fetched: 'the decisive passage is probably in a part of the source that was not retrieved (the text is cut off, or is a different page or a summary).',
    rubric_question: 'the disagreement is about the rubric rather than the reading, e.g. one contradicted detail in an otherwise supported claim (PARTIALLY vs NOT SUPPORTED).',
    editor_likely_wrong: "the editor's judgement is not supported by the retrieved text.",
    other: 'none of the above.',
});

const VERDICT_CHOICES = VERDICT_LIST.join(', ');

// A source longer than this is not sent to the adjudicator whole. It matches
// the Worker's cap (core/worker.js WORKER_CONTENT_CAP), so the adjudicator
// never reads less than the tool could have.
export const MAX_SOURCE_CHARS = 100000;

export function blindSystemPrompt() {
    return `You are reviewing one citation from Wikipedia for a project that audits an automated citation checker. Decide whether the source text supports the claim, using the definitions below.

The question is: does the cited source, as retrieved, support the text the citation is attached to? Not whether the claim is true, and not whether the source is reliable.

The claim is the article text before the citation marker, back to the previous citation. It may be several sentences; the citation covers all of them.

Verdicts:
- SUPPORTED: the source states the claim, directly or through plain paraphrase or straightforward implication.
- PARTIALLY SUPPORTED: the source backs some of the claim but not all of it, or hedges something the claim states as fact.
- NOT SUPPORTED: the source contradicts the claim, or does not address it. reason_type is "contradiction" when the source says something incompatible with the claim, such as a different date, number or place (this outranks partial support), and "omission" when it does not address the claim.
- SOURCE UNAVAILABLE: the retrieved text is not usable: a library catalogue, database record or book metadata page; a paywall, login page or access-denied message; a cookie notice, bot check or JavaScript error; a 404 or redirect notice; bibliographic details with none of the cited content. Page clutter around real content does not make a source unusable.

Rules:
- Only the source counts. Never use outside knowledge.
- The source's URL is part of the source: it can establish who published it (a page on handelszeitung.ch is published by the Handelszeitung). A dateline or publication date in the text anchors relative dates in it ("on Thursday", "last year").
- Accept paraphrase and plain implication. Reject speculation and logical leaps.
- Do not require the source to use the claim's wording.
- Different romanizations of a name are the same name.
- Read the whole source text before deciding that something is absent. Evidence is often in a table, a list or a caption.

Respond with JSON only:
{"verdict": "<one of ${VERDICT_CHOICES}>", "reason_type": "contradiction" | "omission" | null, "evidence_quote": "<passage>", "explanation": "<two or three sentences, in English>"}

evidence_quote is the passage that decides your verdict, copied exactly, character for character, from the source text — at most about 50 words; join two passages with " ... ". It is checked automatically and discarded if it is not in the source. Use "" for an omission or for SOURCE UNAVAILABLE.`;
}

export function blindUserContent({ claimText, articleTitle, wiki, citationNumber, sourceUrl, sourceText, sourceTruncated }) {
    const where = [articleTitle, wiki && `(${wiki})`].filter(Boolean).join(' ');
    const cite = citationNumber ? `, citation [${citationNumber}]` : '';
    const text = String(sourceText ?? '').slice(0, MAX_SOURCE_CHARS);
    const cut = sourceTruncated || String(sourceText ?? '').length > MAX_SOURCE_CHARS
        ? ', cut off at a length limit; the rest of the source was not retrieved'
        : '';
    return `Article: ${where || 'unknown'}${cite}
Claim: "${claimText}"

Source URL: ${sourceUrl}
Source text${cut}:
${text}`;
}

export function attributionSystemPrompt() {
    const causes = Object.entries(ATTRIBUTION_DESCRIPTIONS).map(([id, d]) => `- ${id}: ${d}`).join('\n');
    return `You are diagnosing a disagreement about one automated citation check on Wikipedia. You are given the claim, what the automated checker concluded, what a human editor said about that conclusion, and the reading of an independent reviewer who saw the same source text without seeing either judgement.

Name the ONE primary cause from this list:
${causes}

Respond with JSON only:
{"cause": "<one id from the list>", "tool_verdict_correct": true | false, "editor_correct": true | false | null, "explanation": "<two or three sentences, in English>"}

editor_correct is null when the editor rejected the checker's verdict without saying what it should be.`;
}

function quoteLine(text, status) {
    if (!text) return '(none)';
    return `"${text}" [${status}]`;
}

export function attributionUserContent(c, blind, { blindQuote, toolQuote, hints = [], sourceLength, sourceTruncated }) {
    const editorSaid = c.editor.inconsistent
        ? `thumbs-down, but chose ${c.editor.verdict} — the verdict the checker had already given`
        : c.editor.verdict && c.editor.disagrees
            ? `the verdict is wrong; it should be ${c.editor.verdict}`
            : c.editor.verdict
                ? 'the verdict is right'
                : 'the verdict is wrong (no corrected verdict given)';
    const hintLines = hints.length
        ? hints.map(id => `- ${id}: ${causeRule(id)?.label ?? ''}`).join('\n')
        : '- none';
    return `Claim: "${c.check.claimText}"
Source URL: ${c.check.sourceUrl}
Retrieved text: ${sourceLength} characters${sourceTruncated ? ', cut off at a length limit' : ''}.

The checker (${c.check.model ?? 'unknown model'}) said: ${c.check.verdict}${c.check.reasonType ? ` (${c.check.reasonType})` : ''}.
Its explanation: "${c.check.comments}"
Its quote: ${quoteLine(c.check.sourceQuote, toolQuote.status)}

The editor said: ${editorSaid}.

The independent reviewer said: ${blind.verdict}${blind.reasonType ? ` (${blind.reasonType})` : ''}.
Its evidence: ${quoteLine(blind.evidenceQuote, blindQuote.status)}
Its explanation: "${blind.explanation}"

Patterns found in the checker's explanation (automatic, unverified):
${hintLines}`;
}

// Models wrap JSON in prose or code fences often enough to tolerate both.
export function extractJson(text) {
    const s = String(text ?? '').trim();
    const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const body = fenced ? fenced[1] : (s.match(/\{[\s\S]*\}/) || [null])[0];
    if (!body) throw new Error('no JSON object in the response');
    return JSON.parse(body);
}

export function parseBlindResponse(text) {
    const raw = extractJson(text);
    const verdict = canonicalizeVerdict(raw.verdict);
    if (!verdict) throw new Error(`unrecognized verdict ${JSON.stringify(raw.verdict)}`);
    const reasonType = verdict === 'NOT SUPPORTED' && ['contradiction', 'omission'].includes(raw.reason_type)
        ? raw.reason_type
        : (verdict === 'NOT SUPPORTED' ? 'omission' : null);
    return {
        verdict,
        reasonType,
        evidenceQuote: typeof raw.evidence_quote === 'string' ? raw.evidence_quote.trim() : '',
        explanation: typeof raw.explanation === 'string' ? raw.explanation.trim() : '',
    };
}

export function parseAttributionResponse(text) {
    const raw = extractJson(text);
    const known = Object.values(ATTRIBUTION_CAUSES);
    const cause = known.includes(raw.cause) ? raw.cause : ATTRIBUTION_CAUSES.OTHER;
    const bool = v => (v === true || v === false ? v : null);
    return {
        cause,
        claimedCause: raw.cause ?? null,
        toolVerdictCorrect: bool(raw.tool_verdict_correct),
        editorCorrect: bool(raw.editor_correct),
        explanation: typeof raw.explanation === 'string' ? raw.explanation.trim() : '',
    };
}

/**
 * Runs the adjudication for one case.
 *
 * @param {object} c - normalizeCase() output
 * @param {object} opts
 * @param {string} opts.sourceText - the re-fetched source body (not framed)
 * @param {boolean} opts.sourceTruncated
 * @param {string[]} opts.hints - tagCauses(c.check)
 * @param {(req: {purpose: 'blind'|'attribution', systemPrompt: string, userContent: string}) =>
 *   Promise<{text: string, usage?: {input?: number, output?: number}}>} opts.callModel
 * @returns {Promise<object>} the adjudication record stored on the field row
 */
export async function adjudicateCase(c, { sourceText, sourceTruncated = false, hints = [], callModel, model = null }) {
    const usage = { input: 0, output: 0, calls: 0 };
    const add = u => {
        usage.input += u?.input ?? 0;
        usage.output += u?.output ?? 0;
        usage.calls += 1;
    };

    const blindResponse = await callModel({
        purpose: 'blind',
        systemPrompt: blindSystemPrompt(),
        userContent: blindUserContent({
            claimText: c.check.claimText,
            articleTitle: c.check.articleTitle,
            wiki: c.check.wiki,
            citationNumber: c.check.citationNumber,
            sourceUrl: c.check.sourceUrl,
            sourceText,
            sourceTruncated,
        }),
    });
    add(blindResponse.usage);
    const blind = parseBlindResponse(blindResponse.text);
    const blindQuote = verifyQuote(sourceText, blind.evidenceQuote);
    const toolQuote = verifyQuote(sourceText, c.check.sourceQuote);

    const everyoneAgrees = c.editor.verdict === c.check.verdict
        && !c.editor.inconsistent
        && blind.verdict === c.check.verdict;

    let attribution;
    if (everyoneAgrees) {
        attribution = {
            cause: ATTRIBUTION_CAUSES.TOOL_CORRECT,
            claimedCause: null,
            toolVerdictCorrect: true,
            editorCorrect: true,
            explanation: 'The editor and the independent reading both agree with the checker.',
        };
    } else {
        const attributionResponse = await callModel({
            purpose: 'attribution',
            systemPrompt: attributionSystemPrompt(),
            userContent: attributionUserContent(c, blind, {
                blindQuote,
                toolQuote,
                hints,
                sourceLength: String(sourceText ?? '').length,
                sourceTruncated,
            }),
        });
        add(attributionResponse.usage);
        attribution = parseAttributionResponse(attributionResponse.text);
    }

    return {
        version: ADJUDICATOR_VERSION,
        model,
        blind: { ...blind, quoteStatus: blindQuote.status, verifiedQuote: blindQuote.verifiedText },
        attribution,
        // The tool's own quote, checked against the text as it is now. A quote
        // that verified when the check ran but not now means the page moved
        // on (or a different copy was fetched): read the verdict with care.
        toolQuoteNow: toolQuote.status,
        sourceDrift: ['exact', 'normalized'].includes(c.check.quoteStatus) && !toolQuote.verified,
        usage,
    };
}

export const LABEL_STATUSES = Object.freeze({
    // The editor and the blind reading reached the same verdict independently,
    // and its evidence (where a verdict calls for one) verified.
    AGREED: 'agreed',
    // Anything else. The reasons say what to decide.
    NEEDS_OWNER: 'needs_owner',
    // Set by hand: the owner decided the label. Never overwritten.
    OWNER: 'owner',
});

/**
 * The label a triaged case implies, decided by rule rather than by a model.
 *
 * `groundTruth` is pre-filled even when the owner must decide — with the
 * editor's verdict where there is one, the adjudicator's otherwise — so that
 * accepting a suggestion is one edit (needs_manual_review: false).
 */
export function proposeLabel(c, adjudication) {
    const reasons = [];
    const editor = c.editor;
    const blind = adjudication.blind;
    let excludedReason = null;

    if (editor.inconsistent) reasons.push('the editor\'s feedback contradicts itself');
    if (!editor.verdict) reasons.push('the editor rejected the verdict without giving one');
    else if (blind.verdict !== editor.verdict) reasons.push(`the independent reading says ${blind.verdict}, the editor ${editor.verdict}`);

    if (quoteExpectedFor(blind.verdict, blind.reasonType) && !['exact', 'normalized'].includes(blind.quoteStatus)) {
        reasons.push(`the independent reading's evidence was not found in the source (${blind.quoteStatus})`);
    }

    // The editor judged the real source; the text we hold is something else.
    // Kept, but out of scoring, like dataset.json's excluded rows — and useful
    // as a test case for detecting unusable pages.
    if (blind.verdict === 'SOURCE UNAVAILABLE' && editor.verdict && editor.verdict !== 'SOURCE UNAVAILABLE') {
        excludedReason = 'retrieved text is not the cited source (independent reading)';
    }

    if (adjudication.sourceDrift) reasons.push('the source has changed since the check ran');

    const suggested = editor.verdict ?? blind.verdict;
    return {
        groundTruth: suggested ? toTitleCase(suggested) : null,
        suggestedBy: editor.verdict ? 'editor' : 'adjudicator',
        labelStatus: reasons.length === 0 ? LABEL_STATUSES.AGREED : LABEL_STATUSES.NEEDS_OWNER,
        reasons,
        excludedReason,
    };
}
