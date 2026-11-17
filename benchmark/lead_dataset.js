// The lead-check benchmark: lead sentences labeled against their article's
// body, and the scoring of a run against those labels. Pure helpers; the
// extract / run / analyze scripts are the I/O around them.
//
// A separate corpus from dataset.json, for the reason WiCE is: it measures a
// different task (does the body cover this lead sentence?, not does this
// source support this claim?), so pooling the two would change what headline
// accuracy means. See docs/design-plans/2026-10-22-lead-checks.md.
//
// Labels are a person's judgment of the body as stored here, made by reading
// all of it:
//   covered        the body states it, or fairly summarizes to it
//   partly_covered the body covers some of it; a specific detail is missing
//   not_covered    the body doesn't address it
//   contradicted   the body states something incompatible with it
// The positive class is anything but `covered`, the same direction as the
// rest of the repo ("positive = the case an editor has to act on").

import { leadSentences, articleBody } from '../core/lead.js';
import { LEAD_OUTCOMES } from '../core/lead-check.js';
import { VERDICTS } from '../core/verdicts.js';

export const LEAD_LABELS = Object.freeze(['covered', 'partly_covered', 'not_covered', 'contradicted']);

export function leadArticleId(wiki, title, revisionId) {
    return `${wiki}:${title}@${revisionId ?? 'latest'}`;
}

/**
 * One article's dataset entry: its body as the lead check reads it, and its
 * lead sentences with empty labels. The body is stored, not re-fetched, so a
 * labeled set stays reproducible after the article changes.
 */
export function leadDatasetEntry({ wiki, title, revisionId = null, root, splitSentences }) {
    const sentences = leadSentences(root, splitSentences ? { splitSentences } : {});
    const body = articleBody(root, { leadText: sentences.map(s => s.text).join(' ') });
    return {
        id: leadArticleId(wiki, title, revisionId),
        wiki,
        title,
        revision_id: revisionId,
        body: { text: body.text, sections: body.sections, chars: body.chars, totalChars: body.totalChars, truncated: body.truncated },
        sentences: sentences.map(s => ({ index: s.index, paragraphIndex: s.paragraphIndex, text: s.text, label: null, notes: '' })),
    };
}

/**
 * Carries labels from an earlier version of the dataset onto re-extracted
 * entries, matched by article id and exact sentence text, so re-running the
 * extraction never throws away a person's labeling. Returns the number of
 * labels kept.
 */
export function carryOverLabels(entries, previous) {
    const byArticle = new Map((previous || []).map(e => [e.id, e]));
    let kept = 0;
    for (const entry of entries) {
        const old = byArticle.get(entry.id);
        if (!old) continue;
        const byText = new Map(old.sentences.map(s => [s.text, s]));
        for (const s of entry.sentences) {
            const before = byText.get(s.text);
            if (before && before.label) {
                s.label = before.label;
                s.notes = before.notes || '';
                kept++;
            }
        }
    }
    return kept;
}

// A model result as one of the label values. PARTIALLY SUPPORTED and an
// omission both mean "add it to the body", which is how the tool reports
// them; the label set keeps them apart so a later analysis can.
function predictedLabel(result) {
    if (!result || !result.verdict) return null;
    if (result.outcome === LEAD_OUTCOMES.COVERED) return 'covered';
    if (result.outcome === LEAD_OUTCOMES.CONTRADICTED) return 'contradicted';
    return result.verdict === VERDICTS.PARTIALLY_SUPPORTED ? 'partly_covered' : 'not_covered';
}

const isPositive = label => label !== 'covered';

/**
 * Scores one provider's results against the labels: only labeled sentences
 * count, and a sentence the run left unchecked is reported, not scored.
 *
 * `results` is a list of `{ article_id, sentence_index, verdict, outcome, ... }`
 * for one provider.
 */
export function scoreLeadRun(dataset, results) {
    const byKey = new Map(results.map(r => [`${r.article_id}#${r.sentence_index}`, r]));
    const confusion = Object.fromEntries(LEAD_LABELS.map(l => [l, Object.fromEntries([...LEAD_LABELS, 'unchecked'].map(p => [p, 0]))]));
    let labeled = 0;
    let scored = 0;
    let exact = 0;
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const entry of dataset) {
        for (const s of entry.sentences) {
            if (!LEAD_LABELS.includes(s.label)) continue;
            labeled++;
            const predicted = predictedLabel(byKey.get(`${entry.id}#${s.index}`));
            confusion[s.label][predicted ?? 'unchecked']++;
            if (!predicted) continue;
            scored++;
            if (predicted === s.label) exact++;
            const actual = isPositive(s.label);
            const flagged = isPositive(predicted);
            if (actual && flagged) tp++;
            else if (!actual && flagged) fp++;
            else if (actual && !flagged) fn++;
            else tn++;
        }
    }
    const ratio = (n, d) => (d ? n / d : null);
    return {
        positive_class: 'label is anything but covered: the lead says something the body does not back',
        labeled,
        scored,
        unchecked: labeled - scored,
        exact_accuracy: ratio(exact, scored),
        binary_accuracy: ratio(tp + tn, scored),
        tpr: ratio(tp, tp + fn),
        fpr: ratio(fp, fp + tn),
        precision: ratio(tp, tp + fp),
        counts: { tp, fp, fn, tn },
        confusion,
    };
}
