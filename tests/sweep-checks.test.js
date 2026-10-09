import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createSweepChecker, reviewRows, renderMarkdown, formatProblems, junkInClaim, isTableLikeClaim,
    scriptShare, LEVELS, SUSPECT_CAP, THRESHOLDS,
} from '../service/sweep-checks.js';
import { parseCsv, rowsToCsv } from '../service/csv-report.js';
import { STUB_FETCH_ERROR } from '../core/worker.js';

// Findings as service/finding-builder.js shapes them, turned into the
// string-valued rows a CSV read gives back — so every test exercises the real
// column names and cell encodings, not a hand-written imitation.
function toRows(findings) {
    const [header, ...records] = parseCsv(rowsToCsv(findings));
    return records.map(r => Object.fromEntries(header.map((name, i) => [name, r[i]])));
}

let counter = 0;
function finding(overrides = {}) {
    counter++;
    return {
        wiki: 'enwiki', pageId: 7, revisionId: 70, pageTitle: 'Test Article', citationNumber: counter,
        isCollective: false, claimText: 'The bridge opened to traffic in 1998 after four years of work.',
        sourceUrl: `https://host${counter}.example/page`, verdict: 'SUPPORTED', supportScore: 90,
        rationale: `The source states the opening year directly (${counter}).`, sourceQuote: 'opened in 1998',
        quoteStatus: 'exact', provider: 'liftwing', model: 'llm-qwen36-27b', promptVersion: 'p1',
        tokensIn: 1200, tokensOut: 80, checkId: `id${counter}`,
        ...overrides,
    };
}
const unavailable = (fetchError, extra = {}) => finding({
    verdict: 'SOURCE UNAVAILABLE', supportScore: null, reasonType: 'fetch_failed', fetchError,
    rationale: null, sourceQuote: null, quoteStatus: null, provider: null, model: null, tokensIn: null, tokensOut: null,
    ...extra,
});

function check(findings, options = {}, finishOptions = {}) {
    const checker = createSweepChecker(options);
    toRows(findings).forEach((row, i) => checker.addRow(row, i + 1));
    return checker.finish(finishOptions);
}
const levelOf = (result, id) => result.checks.find(c => c.id === id)?.level;
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));

test('a clean run passes every check', () => {
    const result = check(many(50, () => finding()), { titles: ['Test Article'] });
    assert.equal(result.status, LEVELS.PASS, JSON.stringify(result.checks.filter(c => c.level !== 'pass' && c.level !== 'info')));
    assert.deepEqual(result.suspects, []);
});

test('coverage names a title that produced no rows (the Iran-war case: 1,223 rows, then 0)', () => {
    const titles = [...many(40, i => `Article ${i}`), 'Timeline of the 2026 Iran war'];
    const result = check(many(40, i => finding({ pageTitle: `Article ${i}` })), { titles });
    assert.equal(levelOf(result, 'coverage'), LEVELS.WARN);
    assert.match(result.checks.find(c => c.id === 'coverage').summary, /Timeline of the 2026 Iran war/);
});

test('coverage fails once more than 5% of titles are missing', () => {
    const result = check([finding({ pageTitle: 'A' })], { titles: ['A', 'B', 'C'] });
    assert.equal(levelOf(result, 'coverage'), LEVELS.FAIL);
});

test('a run that used the fetch stub fails', () => {
    const result = check([finding(), unavailable(STUB_FETCH_ERROR)]);
    assert.equal(levelOf(result, 'stub_fetch'), LEVELS.FAIL);
});

test('our fetcher failing fails the run; publishers failing does not count as ours', () => {
    const ours = check([...many(80, () => finding()), ...many(20, () => unavailable('Proxy returned non-JSON response (HTTP 502)'))]);
    assert.equal(levelOf(ours, 'fetch_ours'), LEVELS.FAIL);
    const theirs = check([...many(80, () => finding()), ...many(20, () => unavailable('Source returned HTTP 404'))]);
    assert.equal(levelOf(theirs, 'fetch_ours'), LEVELS.PASS);
    assert.equal(theirs.metrics.fetchFailureKinds.publisher_http, 20);
});

test('a stretch of failures across many hosts is reported as an outage window', () => {
    const findings = [
        ...many(150, () => finding()),
        ...many(150, () => unavailable('fetch failed')), // a distinct host each
        ...many(150, () => finding()),
    ];
    const result = check(findings);
    assert.equal(levelOf(result, 'fetch_bursts'), LEVELS.WARN);
    assert.match(result.checks.find(c => c.id === 'fetch_bursts').summary, /records \d+–\d+/);
});

test('many dead links on one host are not an outage', () => {
    const findings = [
        ...many(150, () => finding()),
        ...many(150, () => unavailable('Source returned HTTP 404', { sourceUrl: 'https://dead.example/x' })),
        ...many(150, () => finding()),
    ];
    assert.equal(levelOf(check(findings), 'fetch_bursts'), LEVELS.PASS);
});

test('ERROR rows are counted by reason_type and fail above 5%', () => {
    const errors = many(10, i => finding({
        verdict: 'ERROR', reasonType: i % 2 ? 'retries_exhausted' : 'output_budget_exhausted',
        provider: null, model: null, tokensIn: null, supportScore: null,
    }));
    const result = check([...many(90, () => finding()), ...errors]);
    assert.equal(levelOf(result, 'errors'), LEVELS.FAIL);
    assert.deepEqual(result.metrics.errorReasons, { retries_exhausted: 5, output_budget_exhausted: 5 });
});

test('a high share of truncated sources warns (the old 12,000-char rule marked 24%)', () => {
    const result = check([...many(70, () => finding()), ...many(30, () => finding({ sourceTruncated: true }))]);
    assert.equal(levelOf(result, 'truncation'), LEVELS.WARN);
});

test('TemplateStyles CSS in a claim is a suspect row (Moscow Metro, ref [145])', () => {
    const claim = 'Станция открыта в 1935 году .mw-parser-output .ts-fix-template{display:inline}[когда?]';
    assert.deepEqual(junkInClaim(claim), ['CSS', 'maintenance tag']);
    assert.equal(junkInClaim('The bridge opened in 1998.'), null);
    const result = check([...many(10, () => finding()), finding({ claimText: claim })]);
    assert.equal(levelOf(result, 'junk_in_claim'), LEVELS.FAIL);
    assert.equal(result.suspects.find(s => s.check === 'junk_in_claim').count, 1);
});

test('claims too long for one sentence warn, and fail when common (Cyrillic never split)', () => {
    const long = 'Слово '.repeat(150);
    assert.equal(levelOf(check([...many(97, () => finding()), ...many(3, () => finding({ claimText: long }))]), 'claim_length'), LEVELS.WARN);
    assert.equal(levelOf(check([...many(80, () => finding()), ...many(20, () => finding({ claimText: long }))]), 'claim_length'), LEVELS.FAIL);
});

test('an article made of score lines is reported (the US Open draws)', () => {
    assert.equal(isTableLikeClaim('6–4, 3–6, 7–6(7–5)'), true);
    assert.equal(isTableLikeClaim('Born 12 March 1980 in Lagos'), false);
    const draws = many(12, () => finding({ pageTitle: '2026 US Open – Men\'s singles', claimText: '6–4, 3–6, 7–6(7–5)' }));
    const result = check([...many(20, () => finding()), ...draws]);
    assert.equal(levelOf(result, 'table_like_articles'), LEVELS.WARN);
    assert.match(result.checks.find(c => c.id === 'table_like_articles').summary, /US Open/);
});

test('English rationales on a ruwiki run fail (the batch path ignored the wiki language before 2026-09-13)', () => {
    const ru = { wiki: 'ruwiki', claimText: 'Станция открыта в 1935 году.' };
    const russian = many(50, () => finding({ ...ru, rationale: 'Источник прямо называет год открытия станции.' }));
    const english = many(50, () => finding({ ...ru, rationale: 'The source directly states the opening year of the station.' }));
    const bad = check([...russian, ...english]);
    assert.equal(bad.metrics.wikiLang, 'ru', 'read off the permalinks when --wiki is not given');
    assert.equal(levelOf(bad, 'rationale_language'), LEVELS.FAIL);
    assert.equal(levelOf(check(russian), 'rationale_language'), LEVELS.PASS);
    // A Russian rationale quoting an English title is still Russian.
    assert.ok(scriptShare('Источник The Guardian подтверждает дату открытия.', 'Cyrillic').share > 0.5);
});

test('rationale language is not judged on a wiki that shares English\'s script', () => {
    const result = check(many(10, () => finding({ rationale: 'Les sources confirment la date.' })), { wiki: 'frwiki' });
    assert.equal(levelOf(result, 'rationale_language'), LEVELS.INFO);
});

test('formatProblems checks the prompt\'s own rules', () => {
    const row = overrides => ({ verdict: 'SUPPORTED', support_score: '90', reason_type: '', source_quote: 'q', rationale: 'r', ...overrides });
    assert.deepEqual(formatProblems(row()), []);
    assert.deepEqual(formatProblems(row({ support_score: '30' })), ['support_score 30 outside SUPPORTED\'s 80–100']);
    assert.deepEqual(formatProblems(row({ verdict: 'NOT SUPPORTED', support_score: '10', reason_type: '' })),
        ['NOT SUPPORTED with reason_type ""']);
    assert.deepEqual(formatProblems(row({ verdict: 'NOT SUPPORTED', support_score: '10', reason_type: 'omission' })),
        ['source_quote on NOT SUPPORTED/omission']);
    assert.deepEqual(formatProblems(row({ reason_type: 'contradiction' })), ['reason_type "contradiction" on SUPPORTED']);
    assert.deepEqual(formatProblems(row({ rationale: ' ' })), ['empty rationale']);
});

test('an unknown verdict fails; SKIPPED and ERROR are known', () => {
    const result = check([finding(), finding({ verdict: 'MAYBE' }), finding({ verdict: 'SKIPPED', provider: null, tokensIn: null, reasonType: 'claim_too_short' })]);
    assert.equal(levelOf(result, 'unknown_verdict'), LEVELS.FAIL);
    assert.equal(result.suspects.find(s => s.check === 'unknown_verdict').count, 1);
});

test('a CSV mixing prompt versions warns (a --resume across a code update)', () => {
    const result = check([...many(5, () => finding()), ...many(5, () => finding({ promptVersion: 'p2' }))]);
    assert.equal(levelOf(result, 'provenance'), LEVELS.WARN);
});

test('rows without a permalink warn (the --titles-file runs that never resolved ids)', () => {
    const result = check([finding(), finding({ pageId: null, revisionId: null })]);
    assert.equal(levelOf(result, 'identity'), LEVELS.WARN);
});

test('duplicate rows fail', () => {
    const one = finding();
    const result = check([one, { ...one }]);
    assert.equal(levelOf(result, 'structure'), LEVELS.FAIL);
});

test('a record cut off at the end of the file only warns', () => {
    const checker = createSweepChecker();
    toRows(many(3, () => finding())).forEach((row, i) => checker.addRow(row, i + 1));
    checker.addMalformed(['Cut Article', '7'], 4);
    const result = checker.finish({ lastIndex: 4, unterminated: true });
    assert.equal(levelOf(result, 'structure'), LEVELS.WARN);
});

test('missing severity is only a suspect on a run that used --severity', () => {
    const flagged = () => finding({ verdict: 'NOT SUPPORTED', supportScore: 10, reasonType: 'contradiction' });
    const withoutPass = check(many(5, flagged));
    assert.equal(withoutPass.checks.find(c => c.id === 'severity'), undefined);
    assert.equal(withoutPass.suspects.find(s => s.check === 'severity_missing'), undefined);
    const withPass = check([...many(5, flagged), finding({ verdict: 'NOT SUPPORTED', supportScore: 10, reasonType: 'contradiction', severityTier: 'T1' })]);
    assert.equal(levelOf(withPass, 'severity'), LEVELS.WARN);
    assert.equal(withPass.suspects.find(s => s.check === 'severity_missing').count, 5);
});

test('suspect rows keep the full count but only SUSPECT_CAP examples', () => {
    const result = check(many(100, () => finding({ claimText: 'Text with a stray {{citation needed}} template' })));
    const junk = result.suspects.find(s => s.check === 'junk_in_claim');
    assert.equal(junk.count, 100);
    assert.equal(junk.examples.length, SUSPECT_CAP);
});

test('the review rows carry suspects and a sample per verdict, each row once, reproducibly', () => {
    const findings = [
        ...many(40, () => finding()),
        ...many(40, () => finding({ verdict: 'NOT SUPPORTED', supportScore: 10, reasonType: 'omission', sourceQuote: null })),
        finding({ verdict: 'NOT SUPPORTED', supportScore: 90, reasonType: 'contradiction' }), // a format suspect, and sampled
    ];
    const header = parseCsv(rowsToCsv([]))[0];
    const first = reviewRows(check(findings, { seed: 7 }), header);
    const second = reviewRows(check(findings, { seed: 7 }), header);
    assert.deepEqual(first, second, 'same seed, same review file');
    assert.deepEqual(first[0].slice(0, 3), ['review_reason', 'review_detail', 'record']);
    const reasons = first.slice(1).map(r => r[0]);
    assert.equal(reasons.filter(r => r === 'sample:supported').length, 15);
    assert.equal(reasons.filter(r => r === 'sample:not_supported_omission').length, 15);
    const both = first.slice(1).filter(r => r[0].includes('suspect:format'));
    assert.equal(both.length, 1);
    assert.match(both[0][0], /suspect:format sample:not_supported_contradiction/);
    assert.equal(new Set(first.slice(1).map(r => r[2])).size, first.length - 1, 'no record twice');
});

test('renderMarkdown leads with the status and lists every check', () => {
    const result = check([finding(), unavailable(STUB_FETCH_ERROR)]);
    const md = renderMarkdown(result, { file: 'f.csv' });
    assert.match(md, /^# Sweep checks: FAIL/);
    for (const c of result.checks) assert.ok(md.includes(c.title), c.title);
});

test('an empty CSV fails', () => {
    assert.equal(check([]).status, LEVELS.FAIL);
});

test('THRESHOLDS is frozen, so a test cannot quietly loosen it for the next one', () => {
    assert.ok(Object.isFrozen(THRESHOLDS));
});
