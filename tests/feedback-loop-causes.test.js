import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    PATTERNS,
    CAUSE_RULES,
    CAUSE_IDS,
    LONG_CLAIM_CHARS,
    causeRule,
    causeSql,
    sqlIsExact,
    tagCauses,
    sourceHost,
    publisherToken,
    namesOwnSource,
} from '../feedback-loop/causes.js';

// normalizeCase()'s `check` shape, defaulting to an unremarkable flag.
function check(overrides = {}) {
    return {
        verdict: 'NOT SUPPORTED',
        reasonType: 'contradiction',
        sourceQuote: 'A passage the model quoted.',
        claimText: 'The bridge was completed in 1998.',
        comments: 'The source says the bridge opened in 2002.',
        sourceUrl: 'https://example.org/story',
        ...overrides,
    };
}

// The rationales below are real ones from verification_logs, quoted in
// docs/design-plans/2026-11-08-fixable-causes-of-disputed-verdicts.md.

test('an unremarkable contradiction carries no cause', () => {
    assert.deepEqual(tagCauses(check()), []);
});

test('fetch_failed: the userscript\'s own fetch error, never a model verdict', () => {
    assert.deepEqual(tagCauses(check({ verdict: 'SOURCE UNAVAILABLE', comments: 'HTTP 200: Source returned 402', sourceQuote: '' })), ['fetch_failed']);
    assert.ok(!tagCauses(check({ comments: 'HTTP 200: Source returned 402' })).includes('fetch_failed'));
});

test('citation_metadata: a date the dateline would have given', () => {
    assert.ok(tagCauses(check({
        reasonType: 'omission',
        comments: 'The source confirms the statement about droughts but does not mention the specific date July 6, 2008, so the claim is not fully supported.',
    })).includes('citation_metadata'));
    assert.ok(tagCauses(check({
        comments: 'The source specifies the time as 3:22 p.m. on Thursday, not May 21, 2026, contradicting the claim.',
    })).includes('citation_metadata'));
});

test('citation_metadata: a claim naming its own publisher', () => {
    const guardian = check({
        reasonType: 'omission', sourceQuote: '',
        claimText: 'Catherine Bray of The Guardian gave the film 3 stars out of 5.',
        sourceUrl: 'https://www.theguardian.com/film/2024/mar/18/brightwood-review',
        comments: 'The Guardian review quotes the phrases but does not state a 3-star rating.',
    });
    assert.equal(namesOwnSource(guardian), true);
    assert.ok(tagCauses(guardian).includes('citation_metadata'));
    assert.equal(namesOwnSource({ ...guardian, comments: 'The review gives it 4 stars.' }), false);
});

test('sourceHost and publisherToken look through Wayback and skip non-names', () => {
    assert.equal(sourceHost('https://web.archive.org/web/20230716052016/https://www.reuters.com/article/x'), 'reuters.com');
    assert.equal(sourceHost('https://www.handelszeitung.ch/insurance/x'), 'handelszeitung.ch');
    assert.equal(sourceHost('not a url'), null);
    assert.equal(publisherToken('https://www.handelszeitung.ch/insurance/x'), 'handelszeitung');
    assert.equal(publisherToken('https://edition.cnn.com/2023/x'), null, 'cnn is too short to test safely');
    assert.equal(publisherToken('https://experts.umn.edu/en/persons/x'), null);
});

test('unusable_page: the rationale itself says the page is not the source', () => {
    assert.ok(tagCauses(check({
        reasonType: 'omission', sourceQuote: '',
        comments: 'The source is only a login page and contains no information about any species’ IUCN status.',
    })).includes('unusable_page'));
    assert.ok(tagCauses(check({
        comments: 'The source page does not contain the specific statistics cited in the claim; it only links to a PDF that is not included in the provided text.',
    })).includes('unusable_page'));
});

test('readable_called_unavailable: a readable article reported as unreadable', () => {
    const mumford = check({
        verdict: 'SOURCE UNAVAILABLE', sourceQuote: '', reasonType: null,
        comments: "The provided source text is an article about Mumford & Sons' album 'Babel' and its chart performance. It contains no information regarding an album titled 'Believe'.",
    });
    assert.deepEqual(tagCauses(mumford), ['readable_called_unavailable']);
    // A genuinely unusable page is not "readable", whatever else it says.
    assert.ok(!tagCauses({ ...mumford, comments: 'The source text is a JavaScript error message and contains no article content to verify the claim.' })
        .includes('readable_called_unavailable'));
});

test('rationale_contradicts_verdict and demands_wording', () => {
    assert.ok(tagCauses(check({
        reasonType: 'omission',
        comments: 'The source mentions their appointment as deputy ministers but does not state that they spent several months serving in that role.',
    })).includes('rationale_contradicts_verdict'));
    assert.ok(tagCauses(check({
        reasonType: 'omission', sourceQuote: '',
        comments: 'The source mentions that the temperature rose, but does not contain the exact phrase "As the temperature inside the tank continued to rise,"',
    })).includes('demands_wording'));
    // PARTIALLY SUPPORTED with "confirms X but not Y" is the rubric working.
    assert.ok(!tagCauses(check({ verdict: 'PARTIALLY SUPPORTED', comments: 'Confirms the plans but not the road names.' }))
        .includes('rationale_contradicts_verdict'));
});

test('uncheckable_omission needs an omission with no quote', () => {
    assert.ok(tagCauses(check({ reasonType: 'omission', sourceQuote: '' })).includes('uncheckable_omission'));
    assert.ok(!tagCauses(check({ reasonType: 'omission', sourceQuote: 'Some passage.' })).includes('uncheckable_omission'));
    assert.ok(!tagCauses(check({ reasonType: 'contradiction', sourceQuote: '' })).includes('uncheckable_omission'));
});

test('claim_too_long applies to flags at the threshold', () => {
    const long = 'x'.repeat(LONG_CLAIM_CHARS);
    assert.ok(tagCauses(check({ claimText: long })).includes('claim_too_long'));
    assert.ok(!tagCauses(check({ claimText: long.slice(1) })).includes('claim_too_long'));
    assert.ok(!tagCauses(check({ verdict: 'SUPPORTED', claimText: long })).includes('claim_too_long'));
});

test('claim_fragment: short claims and rationales that say so, but not fetch failures', () => {
    assert.ok(tagCauses(check({ verdict: 'SOURCE UNAVAILABLE', claimText: 'Airstrike.', comments: "The claim 'Airstrike.' is a single word fragment." })).includes('claim_fragment'));
    assert.ok(tagCauses(check({ verdict: 'SUPPORTED', claimText: 'Least Concern (IUCN 3.1)' })).includes('claim_fragment'));
    assert.ok(!tagCauses(check({ verdict: 'SOURCE UNAVAILABLE', claimText: 'Airstrike.', comments: 'HTTP 200: Source returned 403' })).includes('claim_fragment'));
});

test('patterns use only syntax JS and Postgres ARE share', () => {
    for (const [id, source] of Object.entries(PATTERNS)) {
        assert.doesNotThrow(() => new RegExp(source, 'i'), id);
        assert.ok(!/\\b|\(\?<|\(\?=|\(\?!/.test(source), `${id} uses JS-only regex syntax`);
    }
});

test('every pattern a rule names exists', () => {
    for (const rule of CAUSE_RULES) {
        for (const id of [...(rule.all ?? []), ...(rule.any ?? []), ...(rule.none ?? [])]) {
            assert.ok(PATTERNS[id], `${rule.id} names unknown pattern ${id}`);
        }
    }
});

test('causeSql compiles a rule to the same conditions', () => {
    assert.equal(
        causeSql(causeRule('uncheckable_omission')),
        "verdict IN ('NOT SUPPORTED') AND reason_type = 'omission' AND btrim(coalesce(source_quote, '')) = ''",
    );
    const readable = causeSql(causeRule('readable_called_unavailable'));
    assert.ok(readable.includes("doesn[''’]t"), 'single quotes in a pattern are doubled for SQL');
    assert.ok(readable.includes('NOT (coalesce(llm_comments'), 'none-patterns are negated');
    for (const rule of CAUSE_RULES) {
        const sql = causeSql(rule);
        for (const id of [...(rule.all ?? []), ...(rule.any ?? []), ...(rule.none ?? [])]) {
            assert.ok(sql.includes(PATTERNS[id].replace(/'/g, "''")), `${rule.id}: ${id} missing from SQL`);
        }
    }
});

test('only rules with a JS-only alternative are inexact in SQL', () => {
    assert.deepEqual(CAUSE_IDS.filter(id => !sqlIsExact(causeRule(id))), ['citation_metadata']);
});
