import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeCase,
    editorVerdict,
    pageTitleFromUrl,
    pinnedArticleUrl,
    selectForTriage,
    SKIP_REASONS,
    QUICK_RATING_SECONDS,
    HEAVY_SESSION_CHECKS,
} from '../feedback-loop/cases.js';

// Shaped like one element of feedback-loop/sql/cases.sql's output.
function row(overrides = {}) {
    return {
        check_id: 'aaaa0001',
        rating: -1,
        corrected_verdict: 'SUPPORTED',
        wiki_section: null,
        rating_gap_s: 42.5,
        first_feedback_at: '2026-11-01T10:00:00+00:00',
        last_feedback_at: '2026-11-01T10:00:02+00:00',
        feedback_rows: 2,
        raters: 1,
        rater_checks_on_article: 3,
        rater_checks_total: 9,
        checked_at: '2026-11-01T09:59:00+00:00',
        kind: 'source',
        article_url: 'https://en.wikipedia.org/wiki/Drought',
        article_title: 'Drought',
        revision_id: 1369727979,
        citation_number: '13',
        source_url: 'https://example.org/report',
        provider: 'liftwing',
        model: 'llm-qwen38-27b',
        verdict: 'NOT SUPPORTED',
        confidence: 30,
        reason_type: 'omission',
        claim_text: 'Australia could experience more severe droughts.',
        llm_comments: 'The source does not mention droughts.',
        source_quote: null,
        quote_status: 'empty',
        ...overrides,
    };
}

test('normalizeCase maps the export columns and canonicalizes verdicts', () => {
    const c = normalizeCase(row({ verdict: 'not supported', corrected_verdict: 'partially supported' }));
    assert.equal(c.checkId, 'aaaa0001');
    assert.equal(c.rating, -1);
    assert.equal(c.check.verdict, 'NOT SUPPORTED');
    assert.equal(c.correctedVerdict, 'PARTIALLY SUPPORTED');
    assert.equal(c.check.wiki, 'en.wikipedia.org');
    assert.equal(c.check.supportScore, 30);
    assert.equal(c.check.sourceQuote, '', 'a null quote becomes the empty string');
    assert.equal(c.check.citationNumber, '13');
});

test('normalizeCase never carries a rater identity', () => {
    const c = normalizeCase(row({ client_id: 'b492e378b9e64d7d' }));
    assert.ok(!JSON.stringify(c).includes('b492e378b9e64d7d'));
});

test('a PARSE_ERROR verdict normalizes to null but keeps the raw value', () => {
    const c = normalizeCase(row({ verdict: 'PARSE_ERROR' }));
    assert.equal(c.check.verdict, null);
    assert.equal(c.check.rawVerdict, 'PARSE_ERROR');
});

test('quick ratings and heavy sessions are flagged at their thresholds', () => {
    assert.equal(normalizeCase(row({ rating_gap_s: QUICK_RATING_SECONDS - 0.1 })).rater.quick, true);
    assert.equal(normalizeCase(row({ rating_gap_s: QUICK_RATING_SECONDS })).rater.quick, false);
    assert.equal(normalizeCase(row({ rating_gap_s: null })).rater.quick, false, 'a first rating has no gap');
    assert.equal(normalizeCase(row({ rater_checks_on_article: HEAVY_SESSION_CHECKS })).rater.heavySession, true);
    assert.equal(normalizeCase(row({ rater_checks_on_article: HEAVY_SESSION_CHECKS - 1 })).rater.heavySession, false);
});

test('editorVerdict: a correction is the editor\'s answer', () => {
    assert.deepEqual(editorVerdict({ rating: -1, correctedVerdict: 'SUPPORTED', toolVerdict: 'NOT SUPPORTED' }),
        { verdict: 'SUPPORTED', disagrees: true, inconsistent: false });
});

test('editorVerdict: a thumbs-up endorses the tool, a bare thumbs-down only rejects it', () => {
    assert.deepEqual(editorVerdict({ rating: 1, correctedVerdict: null, toolVerdict: 'NOT SUPPORTED' }),
        { verdict: 'NOT SUPPORTED', disagrees: false, inconsistent: false });
    assert.deepEqual(editorVerdict({ rating: -1, correctedVerdict: null, toolVerdict: 'NOT SUPPORTED' }),
        { verdict: null, disagrees: true, inconsistent: false });
});

test('editorVerdict: feedback that contradicts itself is marked inconsistent', () => {
    // Seen in the real data (20e5e17a): a thumbs-down "corrected" to the
    // verdict the tool had already given.
    assert.equal(editorVerdict({ rating: -1, correctedVerdict: 'SOURCE UNAVAILABLE', toolVerdict: 'SOURCE UNAVAILABLE' }).inconsistent, true);
    assert.equal(editorVerdict({ rating: 1, correctedVerdict: 'SUPPORTED', toolVerdict: 'NOT SUPPORTED' }).inconsistent, true);
});

test('pageTitleFromUrl reads /wiki/ links and index.php URLs alike', () => {
    assert.equal(pageTitleFromUrl('https://en.wikipedia.org/wiki/Draft:Coliemore_Harbour'), 'Draft:Coliemore_Harbour');
    assert.equal(pageTitleFromUrl('https://en.wikipedia.org/wiki/Alejandra_Oma%C3%B1a'), 'Alejandra_Omaña');
    assert.equal(pageTitleFromUrl('https://en.wikipedia.org/w/index.php?title=Garden_Grove_chemical_leak&action=edit&section=2'), 'Garden_Grove_chemical_leak');
    assert.equal(pageTitleFromUrl('not a url'), null);
});

test('pinnedArticleUrl keeps the namespace the display title drops', () => {
    assert.equal(
        pinnedArticleUrl('https://en.wikipedia.org/wiki/Draft:Coliemore_Harbour', 1384375344),
        'https://en.wikipedia.org/w/index.php?title=Draft%3AColiemore_Harbour&oldid=1384375344',
    );
});

test('pinnedArticleUrl falls back to the logged URL without a revision', () => {
    assert.equal(pinnedArticleUrl('https://en.wikipedia.org/wiki/Pavlos_Kontides', null),
        'https://en.wikipedia.org/wiki/Pavlos_Kontides');
    assert.equal(pinnedArticleUrl('https://en.wikipedia.org/wiki/X', 0), 'https://en.wikipedia.org/wiki/X');
});

test('selectForTriage skips with a reason instead of dropping', () => {
    const cases = [
        row({ check_id: 'done0001' }),
        row({ check_id: 'grp00001', kind: 'group', source_url: null }),
        row({ check_id: 'parse001', verdict: 'PARSE_ERROR' }),
        row({ check_id: 'nourl001', source_url: null }),
        row({ check_id: 'noclm001', claim_text: '  ' }),
        row({ check_id: 'nofb0001', rating: null, corrected_verdict: null }),
        row({ check_id: 'todo0001' }),
    ].map(normalizeCase);
    const { toTriage, skipped } = selectForTriage(cases, ['done0001']);
    assert.deepEqual(toTriage.map(c => c.checkId), ['todo0001']);
    const reasons = Object.fromEntries(skipped.map(s => [s.case.checkId, s.reason]));
    assert.deepEqual(reasons, {
        done0001: SKIP_REASONS.ALREADY_TRIAGED,
        grp00001: SKIP_REASONS.GROUP,
        parse001: SKIP_REASONS.NO_VERDICT,
        nourl001: SKIP_REASONS.NO_SOURCE_URL,
        noclm001: SKIP_REASONS.NO_CLAIM,
        nofb0001: SKIP_REASONS.NO_FEEDBACK,
    });
});

test('selectForTriage puts disputed cases first, newest first, and honours the limit', () => {
    const cases = [
        row({ check_id: 'up000001', rating: 1, corrected_verdict: null, last_feedback_at: '2026-11-09T00:00:00Z' }),
        row({ check_id: 'down0001', last_feedback_at: '2026-11-01T00:00:00Z' }),
        row({ check_id: 'down0002', last_feedback_at: '2026-11-05T00:00:00Z' }),
    ].map(normalizeCase);
    const all = selectForTriage(cases);
    assert.deepEqual(all.toTriage.map(c => c.checkId), ['down0002', 'down0001', 'up000001']);
    const limited = selectForTriage(cases, [], { limit: 2 });
    assert.deepEqual(limited.toTriage.map(c => c.checkId), ['down0002', 'down0001']);
    assert.deepEqual(limited.deferred.map(c => c.checkId), ['up000001']);
});

test('selectForTriage with retriage ignores the existing field set', () => {
    const cases = [row({ check_id: 'done0001' })].map(normalizeCase);
    assert.equal(selectForTriage(cases, ['done0001'], { retriage: true }).toTriage.length, 1);
});
