// Post-run checks for a batch findings CSV (service/run-sweep.js's output).
//
// Over late September and early October 2026 a sweep stopped halting on the
// failures it used to halt on — a retry-exhausted model call, an output
// budget spent on reasoning, an empty response, an oversized source — and
// records each as an ERROR row instead. That is right for runs that last
// hours, and it means a degraded run now finishes looking like a normal one.
// Meanwhile most batch bugs of that period were found by reading CSVs by
// hand: CSS in a claim, a 1,223-row article that silently produced 0 rows on
// a re-run, the source fetcher crash-looping, every ruwiki rationale in
// English. Each check below is one of those, written down once.
//
// Two kinds of check:
//
// - Row checks judge one row on its own ("this claim contains CSS"). Their
//   hits are *suspect rows*: up to SUSPECT_CAP of each are kept as examples
//   for the review CSV, and the full count goes in the report. Not to be
//   confused with "flagged", which everywhere else in service/ means a NOT
//   SUPPORTED or PARTIALLY SUPPORTED verdict.
// - Run checks only mean something as totals (a fetch failure rate, ERROR
//   rows, missing articles). One failed fetch is normal; the rate is what can
//   be wrong.
//
// The checker is a fold over rows — addRow() then finish() — so the caller
// can stream a file of any size through it (service/csv-stream.js). Memory is
// bounded by the number of distinct articles, hosts and rationales, never by
// holding rows.
//
// Thresholds are first guesses, set to catch the incidents named next to
// them, and meant to be recalibrated against past sweeps' CSVs: see THRESHOLDS.

import { VERDICTS, VERDICT_LIST, SKIPPED_VERDICT } from '../core/verdicts.js';
import { classifyFetchError, isOurFetchFailure, FETCH_ERROR_KINDS } from '../core/worker.js';
import { langCodeForWiki } from '../core/wikipedia.js';

export const LEVELS = Object.freeze({ FAIL: 'fail', WARN: 'warn', PASS: 'pass', INFO: 'info' });
const LEVEL_ORDER = [LEVELS.FAIL, LEVELS.WARN, LEVELS.PASS, LEVELS.INFO];

export const THRESHOLDS = Object.freeze({
    // Coverage: titles from the titles file with no rows at all. Some are
    // legitimate (no citations, article fetch failed — the run log names
    // those), so any is a warning; this many is a failure.
    missingTitlesFail: 0.05,
    // Citations whose fetch failed because of *our* fetcher (crash-looping
    // pod, no answer in time), as a share of citations with a URL. The
    // 2026-09-17 outage lost 27% of one run's fetches.
    ourFetchFailWarn: 0.01,
    ourFetchFailFail: 0.05,
    // Every fetch failure, any cause. Link rot alone is substantial on
    // current-events articles, so this is informational until calibrated.
    anyFetchFailWarn: 0.40,
    // Burst detection over citations with a URL, in row order (rows are
    // appended as computed, so row order is roughly time): a window this wide
    // in which at least this share failed, across at least this many hosts,
    // is an outage rather than a run of dead links.
    burstWindow: 100,
    burstFailShare: 0.8,
    burstMinHosts: 20,
    // ERROR rows (any reason_type), as a share of all rows.
    errorWarn: 0.01,
    errorFail: 0.05,
    // Fetched sources marked truncated. The old >= 12,000-char rule marked 35
    // of 143 whole pages (24%); the clean CSV drops most findings on a
    // truncated source, so a high rate costs real findings.
    truncatedWarn: 0.20,
    // Batch claims are one sentence (sentence scope). Longer than this means
    // the sentence split probably failed (it once never split Cyrillic).
    longClaimChars: 600,
    longClaimWarn: 0.02,
    longClaimFail: 0.10,
    // Any claim with CSS/wikitext/markers is worth a look; this share fails.
    junkClaimFail: 0.01,
    // A claim with fewer letters than this share of its non-space characters
    // reads as a table cell or score line ("6–4, 3–6, 7–6").
    tableLikeLetterShare: 0.3,
    // An article is table-like when at least this share of its claims are,
    // over at least this many rows.
    tableLikeArticleShare: 0.5,
    tableLikeArticleMinRows: 10,
    // Rationale in the wrong script for the wiki, as a share of model rows.
    // A row counts as wrong when under this share of its letters are in the
    // expected script (rationales legitimately quote foreign names).
    rationaleScriptRowShare: 0.5,
    rationaleMinLetters: 20,
    wrongLanguageWarn: 0.05,
    wrongLanguageFail: 0.25,
    // Model rows breaking the prompt's own format rules.
    formatWarn: 0.02,
    formatFail: 0.10,
    // One rationale, word for word, on this share of model rows (and at least
    // repeatedRationaleMinRows of them) suggests a degenerate model answer.
    repeatedRationaleShare: 0.02,
    repeatedRationaleMinRows: 10,
});

export const SUSPECT_CAP = 20;
export const SAMPLE_PER_STRATUM = 15;

// core/prompts.js's support score guide. NOT SUPPORTED's floor is relaxed to
// 0 — a model that scores an omission 0 has not misunderstood anything.
const SCORE_BANDS = {
    [VERDICTS.SUPPORTED]: [80, 100],
    [VERDICTS.PARTIALLY_SUPPORTED]: [50, 79],
    [VERDICTS.NOT_SUPPORTED]: [0, 49],
    [VERDICTS.SOURCE_UNAVAILABLE]: [0, 0],
};
const REASON_TYPES = new Set(['contradiction', 'omission']);
const KNOWN_VERDICTS = new Set([...VERDICT_LIST, 'ERROR', SKIPPED_VERDICT]);

// Markup that should never survive into claim text. Each was seen, or is the
// obvious sibling of one seen (TemplateStyles CSS in Moscow Metro's ref [145]).
const JUNK_PATTERNS = [
    ['CSS', /\.mw-parser-output|@media\b|\{[^{}]*:[^{}]*;[^{}]*\}/],
    ['wikitext', /\[\[|\]\]|\{\{|\}\}|<ref\b/i],
    ['HTML tag', /<\/?(?:span|div|sup|style|script|br|small|b|i)\b[^>]*>/i],
    ['footnote marker', /\[\d{1,4}\]/],
    ['maintenance tag', /\[(?:citation needed|when\?|who\?|by whom\?|clarification needed|dubious|failed verification|кем\?|когда\?|источник не указан[^\]]*|нет в источнике)\]/i],
];

// Expected script of a rationale, by language code. Latin-script languages
// other than English can't be told from English by script, so only English
// and non-Latin wikis are checked.
const SCRIPTS = {
    Cyrillic: /\p{Script=Cyrillic}/u,
    Hebrew: /\p{Script=Hebrew}/u,
    Arabic: /\p{Script=Arabic}/u,
    Greek: /\p{Script=Greek}/u,
    Armenian: /\p{Script=Armenian}/u,
    Georgian: /\p{Script=Georgian}/u,
    Latin: /\p{Script=Latin}/u,
};
const LANG_SCRIPT = {
    en: 'Latin',
    ru: 'Cyrillic', uk: 'Cyrillic', be: 'Cyrillic', bg: 'Cyrillic', sr: 'Cyrillic', mk: 'Cyrillic',
    kk: 'Cyrillic', ky: 'Cyrillic', tt: 'Cyrillic', ba: 'Cyrillic', tg: 'Cyrillic', mn: 'Cyrillic',
    he: 'Hebrew', yi: 'Hebrew',
    ar: 'Arabic', fa: 'Arabic', ur: 'Arabic', arz: 'Arabic',
    el: 'Greek', hy: 'Armenian', ka: 'Georgian',
};

export function expectedScriptFor(lang) {
    return LANG_SCRIPT[lang] ?? null;
}

// Share of a text's letters in `script`, and how many letters it has.
export function scriptShare(text, script) {
    const pattern = SCRIPTS[script];
    let letters = 0;
    let matching = 0;
    for (const char of text ?? '') {
        if (!/\p{L}/u.test(char)) continue;
        letters++;
        if (pattern.test(char)) matching++;
    }
    return { letters, share: letters ? matching / letters : 1 };
}

export function junkInClaim(claim) {
    const hits = JUNK_PATTERNS.filter(([, pattern]) => pattern.test(claim ?? '')).map(([name]) => name);
    return hits.length ? hits : null;
}

export function isTableLikeClaim(claim, letterShare = THRESHOLDS.tableLikeLetterShare) {
    const chars = [...(claim ?? '').replace(/\s+/g, '')];
    if (chars.length < 3) return false;
    const letters = chars.filter(c => /\p{L}/u.test(c)).length;
    return letters / chars.length < letterShare;
}

// The format rules core/prompts.js states, for one model-run row. Returns a
// list of problems (empty when the row is fine).
export function formatProblems(row) {
    const problems = [];
    const verdict = row.verdict;
    const band = SCORE_BANDS[verdict];
    const score = row.support_score === '' ? null : Number(row.support_score);
    if (band && score !== null && Number.isFinite(score) && (score < band[0] || score > band[1])) {
        problems.push(`support_score ${score} outside ${verdict}'s ${band[0]}–${band[1]}`);
    }
    if (verdict === VERDICTS.NOT_SUPPORTED && !REASON_TYPES.has(row.reason_type)) {
        problems.push(`NOT SUPPORTED with reason_type "${row.reason_type}"`);
    }
    if (verdict && verdict !== VERDICTS.NOT_SUPPORTED && REASON_TYPES.has(row.reason_type)) {
        problems.push(`reason_type "${row.reason_type}" on ${verdict}`);
    }
    const quoteForbidden = verdict === VERDICTS.SOURCE_UNAVAILABLE
        || (verdict === VERDICTS.NOT_SUPPORTED && row.reason_type === 'omission');
    if (quoteForbidden && row.source_quote) {
        problems.push(`source_quote on ${verdict}${row.reason_type ? `/${row.reason_type}` : ''}`);
    }
    if (!row.rationale?.trim()) problems.push('empty rationale');
    return problems;
}

function hostOf(url) {
    try { return new URL(url).host.toLowerCase(); } catch { return null; }
}

// Wiki language from a permalink such as https://ru.wikipedia.org/w/index.php?...
function langFromPermalink(permalink) {
    const match = /^https?:\/\/([a-z-]+)\.wikipedia\.org\//i.exec(permalink ?? '');
    return match ? match[1].toLowerCase() : null;
}

// Small deterministic PRNG, so a review sample can be reproduced.
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Keeps a uniform random `k` of everything offered, in O(k) memory.
function reservoir(k, random) {
    const items = [];
    let seen = 0;
    return {
        offer(item) {
            seen++;
            if (items.length < k) items.push(item);
            else {
                const j = Math.floor(random() * seen);
                if (j < k) items[j] = item;
            }
        },
        get items() { return items; },
        get seen() { return seen; },
    };
}

const bump = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '0%');
const share = (n, d) => (d ? n / d : 0);

function quickHash(text) {
    // FNV-1a; collisions only merge two rationale counts, which is harmless.
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16) + ':' + text.length;
}

// Review-sample strata: the verifier's own outcomes worth eyeballing.
function stratumOf(row, modelRan) {
    if (!modelRan) return null;
    switch (row.verdict) {
        case VERDICTS.NOT_SUPPORTED:
            return row.reason_type === 'contradiction' ? 'not_supported_contradiction' : 'not_supported_omission';
        case VERDICTS.PARTIALLY_SUPPORTED: return 'partially_supported';
        case VERDICTS.SUPPORTED: return 'supported';
        case VERDICTS.SOURCE_UNAVAILABLE: return 'unavailable_after_fetch';
        default: return null;
    }
}
export const SAMPLE_STRATA = Object.freeze([
    'not_supported_contradiction', 'not_supported_omission', 'partially_supported',
    'supported', 'unavailable_after_fetch',
]);

/**
 * @param {object} [options]
 * @param {string[]} [options.titles] - The titles the run was asked to check
 *   (a --titles-file's contents). Enables the coverage check.
 * @param {string} [options.wiki] - Wiki database name (enwiki, ruwiki). When
 *   absent, the language is read off the rows' permalinks.
 * @param {number} [options.suspectCap] - Example rows kept per row check.
 * @param {number} [options.samplePerStratum] - Review-sample rows per stratum.
 * @param {number} [options.seed] - Seed for the random examples and sample.
 */
export function createSweepChecker({
    titles = null,
    wiki = null,
    suspectCap = SUSPECT_CAP,
    samplePerStratum = SAMPLE_PER_STRATUM,
    seed = 1,
    thresholds = THRESHOLDS,
} = {}) {
    const random = mulberry32(seed);
    let rows = 0;
    let lang = wiki ? langCodeForWiki(wiki) : null;
    const langVotes = {};

    const verdicts = {};
    const errorReasons = {};
    const skippedReasons = {};
    const quoteStatuses = {};
    const severityTiers = {};
    const perArticle = new Map(); // title -> { rows, tableLike, revisions:Set }
    const hosts = new Map();      // host -> { citations, fetchFailed, ourFailed, modelUnavailable }
    const fetchKinds = {};
    const providers = new Set();
    const models = new Set();
    const promptVersions = new Set();
    const duplicateKeys = new Set();
    const rationales = new Map(); // hash -> { count, text }

    let withUrl = 0;
    let fetchFailed = 0;
    let ourFetchFailed = 0;
    let stubRows = 0;
    let fetched = 0;
    let truncated = 0;
    let modelRows = 0;
    let formatRows = 0;
    let unknownVerdicts = 0;
    let missingIdentity = 0;
    let duplicates = 0;
    let malformed = 0;
    let longClaims = 0;
    let junkClaims = 0;
    let claimsChecked = 0;
    let wrongLanguage = 0;
    let languageChecked = 0;
    let severityExpected = 0;
    let severityMissing = 0;
    let severitySeen = false;
    const tokensIn = [];
    const claimLengths = new Map(); // bucket of 20 chars -> count

    // Burst detection state, over citations with a URL in row order.
    const window = [];
    const windowFailedHosts = new Map();
    let windowFailed = 0;
    let burstStart = null;
    const bursts = [];

    const suspects = new Map(); // check -> { count, examples: reservoir }
    const severityGaps = reservoir(suspectCap, random);
    const samples = Object.fromEntries(SAMPLE_STRATA.map(s => [s, reservoir(samplePerStratum, random)]));

    function suspect(check, index, row, detail) {
        if (!suspects.has(check)) suspects.set(check, reservoir(suspectCap, random));
        suspects.get(check).offer({ index, detail, row });
    }

    function pushWindow(index, failed, host) {
        window.push({ index, failed, host });
        if (failed) {
            windowFailed++;
            windowFailedHosts.set(host, (windowFailedHosts.get(host) || 0) + 1);
        }
        if (window.length > thresholds.burstWindow) {
            const old = window.shift();
            if (old.failed) {
                windowFailed--;
                const n = windowFailedHosts.get(old.host) - 1;
                if (n) windowFailedHosts.set(old.host, n); else windowFailedHosts.delete(old.host);
            }
        }
        const inBurst = window.length === thresholds.burstWindow
            && windowFailed / window.length >= thresholds.burstFailShare
            && windowFailedHosts.size >= thresholds.burstMinHosts;
        if (inBurst && burstStart === null) burstStart = window[0].index;
        if (!inBurst && burstStart !== null) {
            bursts.push([burstStart, window[window.length - 2]?.index ?? index]);
            burstStart = null;
        }
    }

    function addRow(row, index = rows + 1) {
        rows++;
        const title = row.page_title ?? '';
        const verdict = row.verdict ?? '';
        const isCollective = row.is_collective === '1';
        // finding-builder.js records provider/model only when a model ran.
        const modelRan = Boolean(row.provider || row.tokens_in);

        if (!lang) {
            const fromLink = langFromPermalink(row.permalink);
            if (fromLink) bump(langVotes, fromLink);
        }

        let article = perArticle.get(title);
        if (!article) perArticle.set(title, article = { rows: 0, tableLike: 0, revisions: new Set() });
        article.rows++;
        if (row.revision_id) article.revisions.add(row.revision_id);

        bump(verdicts, verdict || '(blank)');
        if (!KNOWN_VERDICTS.has(verdict)) {
            unknownVerdicts++;
            suspect('unknown_verdict', index, row, `verdict "${verdict}"`);
        }
        if (verdict === 'ERROR') bump(errorReasons, row.reason_type || '(none)');
        if (verdict === SKIPPED_VERDICT) bump(skippedReasons, row.reason_type || '(none)');

        // Structure: identity and duplicates.
        if (!row.page_id || !row.revision_id || !row.permalink) {
            missingIdentity++;
            suspect('missing_permalink', index, row, 'no page_id / revision_id / permalink');
        }
        const key = [title, row.revision_id, row.citation_number, row.is_collective, row.group_id].join('\u0000');
        if (duplicateKeys.has(key)) {
            duplicates++;
            suspect('duplicate', index, row, `${title} #${row.citation_number} appears more than once`);
        } else duplicateKeys.add(key);

        // Claims. A collective row repeats its members' claim, so only solo
        // rows are counted.
        const claim = row.claim_text ?? '';
        if (!isCollective && claim) {
            claimsChecked++;
            const bucket = Math.min(Math.floor(claim.length / 20), 100);
            claimLengths.set(bucket, (claimLengths.get(bucket) || 0) + 1);
            const junk = junkInClaim(claim);
            if (junk) {
                junkClaims++;
                suspect('junk_in_claim', index, row, `claim contains ${junk.join(', ')}`);
            }
            if (claim.length > thresholds.longClaimChars) {
                longClaims++;
                suspect('claim_too_long', index, row, `claim is ${claim.length} characters`);
            }
            if (isTableLikeClaim(claim, thresholds.tableLikeLetterShare)) {
                article.tableLike++;
                suspect('table_like_claim', index, row, 'claim is mostly digits and punctuation');
            }
        }

        // Fetching, per citation (collective rows carry no fetch of their own).
        if (!isCollective && row.source_url) {
            withUrl++;
            const host = hostOf(row.source_url) ?? '(unparseable)';
            let h = hosts.get(host);
            if (!h) hosts.set(host, h = { citations: 0, fetchFailed: 0, ourFailed: 0, modelUnavailable: 0 });
            h.citations++;
            const failed = row.reason_type === 'fetch_failed';
            if (failed) {
                fetchFailed++;
                h.fetchFailed++;
                const kind = classifyFetchError(row.fetch_error) ?? FETCH_ERROR_KINDS.OTHER;
                bump(fetchKinds, kind);
                if (kind === FETCH_ERROR_KINDS.STUB) stubRows++;
                if (isOurFetchFailure(kind)) { ourFetchFailed++; h.ourFailed++; }
            } else if (verdict !== SKIPPED_VERDICT) {
                fetched++;
                if (row.source_truncated === '1') truncated++;
                if (modelRan && verdict === VERDICTS.SOURCE_UNAVAILABLE) h.modelUnavailable++;
            }
            if (verdict !== SKIPPED_VERDICT) pushWindow(index, failed, host);
        }

        // What the model returned.
        if (modelRan) {
            modelRows++;
            if (row.provider) providers.add(row.provider);
            if (row.model) models.add(row.model);
            if (row.prompt_version) promptVersions.add(row.prompt_version);
            if (row.tokens_in !== '' && row.tokens_in !== undefined) tokensIn.push(Number(row.tokens_in));
            if (row.quote_status) bump(quoteStatuses, row.quote_status);

            if (VERDICT_LIST.includes(verdict)) {
                const problems = formatProblems(row);
                if (problems.length) {
                    formatRows++;
                    suspect('format', index, row, problems.join('; '));
                }
            }

            const rationale = (row.rationale ?? '').trim();
            if (rationale) {
                const hash = quickHash(rationale);
                const entry = rationales.get(hash);
                if (entry) entry.count++;
                else rationales.set(hash, { count: 1, text: rationale.slice(0, 200) });
            }
            const expected = expectedScriptFor(currentLang());
            if (expected && rationale) {
                const { letters, share: inScript } = scriptShare(rationale, expected);
                if (letters >= thresholds.rationaleMinLetters) {
                    languageChecked++;
                    if (inScript < thresholds.rationaleScriptRowShare) {
                        wrongLanguage++;
                        suspect('rationale_language', index, row,
                            `only ${Math.round(inScript * 100)}% of the rationale's letters are ${expected}`);
                    }
                }
            }
        }

        // Severity pass: when it ran, every flagged model row gets a tier or an error.
        if (row.severity_tier || row.severity_error || row.severity_prompt_version) severitySeen = true;
        if (row.severity_tier) bump(severityTiers, row.severity_tier);
        if (modelRan && (verdict === VERDICTS.NOT_SUPPORTED || verdict === VERDICTS.PARTIALLY_SUPPORTED)) {
            severityExpected++;
            if (!row.severity_tier && !row.severity_error) {
                severityMissing++;
                // Kept aside: only a suspect if the run turns out to have used
                // --severity at all, which isn't known until finish().
                severityGaps.offer({ index, detail: 'flagged row with neither severity_tier nor severity_error', row });
            }
        }

        const stratum = stratumOf(row, modelRan);
        if (stratum) samples[stratum].offer({ index, row });
    }

    let lastMalformedIndex = null;
    function addMalformed(fields, index) {
        malformed++;
        lastMalformedIndex = index;
        suspect('malformed_record', index, { page_title: fields[0] ?? '' },
            `record has ${fields.length} fields`);
    }

    function currentLang() {
        if (lang) return lang;
        const top = Object.entries(langVotes).sort((a, b) => b[1] - a[1])[0];
        return top ? top[0] : null;
    }

    // `lastIndex` is the file's final record number: a malformed record there
    // is a run killed mid-append, which is worth a warning, not a failure.
    function finish({ header = null, expectedHeader = null, unterminated = false, lastIndex = null } = {}) {
        const cutOff = unterminated || (lastIndex !== null && lastMalformedIndex === lastIndex);
        const brokenRecords = malformed - (cutOff && lastMalformedIndex === lastIndex ? 1 : 0);
        if (burstStart !== null) bursts.push([burstStart, window[window.length - 1].index]);
        const checks = [];
        const add = (id, level, title, summary, details = []) =>
            checks.push({ id, level, title, summary, details, suspectRows: suspectCount(id) });
        const suspectCount = id => suspects.get(id)?.seen ?? 0;
        const resolvedLang = currentLang();
        const articleTitles = [...perArticle.keys()];

        // --- Structure ---
        const structureProblems = [];
        if (expectedHeader && header) {
            const missingColumns = expectedHeader.filter(c => !header.includes(c));
            if (missingColumns.length) structureProblems.push(`missing columns: ${missingColumns.join(', ')} (older CSV? checks using them are skipped)`);
        }
        if (brokenRecords) structureProblems.push(`${brokenRecords} record(s) with the wrong number of fields`);
        if (cutOff) structureProblems.push('the last record is cut off (the run was probably killed mid-write)');
        if (duplicates) structureProblems.push(`${duplicates} duplicate row(s) (same article, revision and citation)`);
        add('structure', brokenRecords || duplicates ? LEVELS.FAIL : (structureProblems.length ? LEVELS.WARN : LEVELS.PASS),
            'Structure', structureProblems.length ? structureProblems.join('; ') : `${rows} rows parsed cleanly`);

        if (rows === 0) {
            add('rows', LEVELS.FAIL, 'Rows', 'the CSV has no data rows');
            return result();
        }

        // --- Coverage ---
        if (titles) {
            const present = new Set(articleTitles);
            const missing = titles.filter(t => !present.has(t));
            const extra = articleTitles.filter(t => !titles.includes(t));
            const level = !missing.length ? LEVELS.PASS
                : share(missing.length, titles.length) > thresholds.missingTitlesFail ? LEVELS.FAIL : LEVELS.WARN;
            add('coverage', level, 'Coverage',
                missing.length
                    ? `${missing.length} of ${titles.length} title(s) have no rows (no citations, a failed article fetch — the run log's "sweep: skipped" lines say which — or lost): ${missing.slice(0, 15).join(' · ')}${missing.length > 15 ? ' …' : ''}`
                    : `all ${titles.length} title(s) have rows`,
                [
                    ...(extra.length ? [`${extra.length} article(s) in the CSV are not in the titles list: ${extra.slice(0, 10).join(' · ')}`] : []),
                ]);
        }

        // --- Provenance ---
        const multiRevision = [...perArticle.entries()].filter(([, a]) => a.revisions.size > 1).map(([t]) => t);
        const provenanceIssues = [];
        if (models.size > 1) provenanceIssues.push(`${models.size} models: ${[...models].join(', ')}`);
        if (providers.size > 1) provenanceIssues.push(`${providers.size} providers: ${[...providers].join(', ')}`);
        if (promptVersions.size > 1) provenanceIssues.push(`${promptVersions.size} prompt versions: ${[...promptVersions].join(', ')} (a --resume across a code update?)`);
        if (multiRevision.length) provenanceIssues.push(`${multiRevision.length} article(s) checked at more than one revision: ${multiRevision.slice(0, 5).join(' · ')}`);
        add('provenance', provenanceIssues.length ? LEVELS.WARN : LEVELS.PASS, 'Provenance',
            provenanceIssues.length ? provenanceIssues.join('; ')
                : `${[...models].join(', ') || 'no model rows'} · prompt ${[...promptVersions].join(', ') || '—'}`);

        add('identity', missingIdentity ? LEVELS.WARN : LEVELS.PASS, 'Permalinks',
            missingIdentity ? `${missingIdentity} row(s) (${pct(missingIdentity, rows)}) have no page_id/revision_id/permalink` : 'every row has a permalink');

        // --- Fetching ---
        if (stubRows) {
            add('stub_fetch', LEVELS.FAIL, 'Live fetching',
                `${stubRows} citation(s) were never fetched — the run used the stub (no --live-source-fetch)`);
        }
        const kindSummary = Object.entries(fetchKinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
        const ourShare = share(ourFetchFailed, withUrl);
        add('fetch_ours', ourShare > thresholds.ourFetchFailFail ? LEVELS.FAIL : ourShare > thresholds.ourFetchFailWarn ? LEVELS.WARN : LEVELS.PASS,
            'Fetch failures (our side)',
            `${ourFetchFailed} of ${withUrl} citations with a URL (${pct(ourFetchFailed, withUrl)}) failed inside our own fetcher (no answer, or an error page instead of JSON)`);
        const anyShare = share(fetchFailed, withUrl);
        const worstHosts = [...hosts.entries()].filter(([, h]) => h.fetchFailed > 1)
            .sort((a, b) => b[1].fetchFailed - a[1].fetchFailed).slice(0, 10)
            .map(([host, h]) => `${host} ${h.fetchFailed}/${h.citations}`);
        add('fetch_all', anyShare > thresholds.anyFetchFailWarn ? LEVELS.WARN : LEVELS.INFO, 'Fetch failures (all causes)',
            `${fetchFailed} of ${withUrl} (${pct(fetchFailed, withUrl)})${kindSummary ? ` — ${kindSummary}` : ''}`,
            worstHosts.length ? [`most failing hosts: ${worstHosts.join(', ')}`] : []);
        add('fetch_bursts', bursts.length ? LEVELS.WARN : LEVELS.PASS, 'Fetch outage windows',
            bursts.length
                ? `${bursts.length} stretch(es) where ≥${Math.round(thresholds.burstFailShare * 100)}% of ${thresholds.burstWindow} consecutive fetches failed across ≥${thresholds.burstMinHosts} hosts — an outage, not dead links: records ${bursts.map(([a, b]) => `${a}–${b}`).join(', ')}`
                : 'no stretch of failures spread across many hosts');
        const truncShare = share(truncated, fetched);
        add('truncation', truncShare > thresholds.truncatedWarn ? LEVELS.WARN : LEVELS.PASS, 'Truncated sources',
            `${truncated} of ${fetched} fetched citations (${pct(truncated, fetched)}) are marked truncated`);

        // --- Model ---
        const errors = verdicts.ERROR || 0;
        const errorShare = share(errors, rows);
        const errorSummary = Object.entries(errorReasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
        add('errors', errorShare > thresholds.errorFail ? LEVELS.FAIL : errorShare > thresholds.errorWarn ? LEVELS.WARN : LEVELS.PASS,
            'ERROR rows', `${errors} (${pct(errors, rows)})${errorSummary ? ` — ${errorSummary}` : ''}`);
        add('unknown_verdict', unknownVerdicts ? LEVELS.FAIL : LEVELS.PASS, 'Verdict vocabulary',
            unknownVerdicts ? `${unknownVerdicts} row(s) with a verdict outside the known set` : 'every verdict is a known one');
        const formatShare = share(formatRows, modelRows);
        add('format', formatShare > thresholds.formatFail ? LEVELS.FAIL : formatShare > thresholds.formatWarn ? LEVELS.WARN : LEVELS.PASS,
            'Answer format', `${formatRows} of ${modelRows} model rows (${pct(formatRows, modelRows)}) break the prompt's rules (score band, reason_type, quote, empty rationale)`);
        const topRationale = [...rationales.values()].sort((a, b) => b.count - a.count)[0];
        const repeated = topRationale && topRationale.count >= thresholds.repeatedRationaleMinRows
            && share(topRationale.count, modelRows) > thresholds.repeatedRationaleShare;
        add('repeated_rationale', repeated ? LEVELS.WARN : LEVELS.PASS, 'Repeated rationales',
            repeated ? `one rationale appears word for word on ${topRationale.count} rows: "${topRationale.text}"`
                : `most repeated rationale appears ${topRationale?.count ?? 0} time(s)`);
        const expected = expectedScriptFor(resolvedLang);
        if (expected) {
            const wrongShare = share(wrongLanguage, languageChecked);
            add('rationale_language', wrongShare > thresholds.wrongLanguageFail ? LEVELS.FAIL : wrongShare > thresholds.wrongLanguageWarn ? LEVELS.WARN : LEVELS.PASS,
                'Rationale language', `${wrongLanguage} of ${languageChecked} rationales (${pct(wrongLanguage, languageChecked)}) are not in ${expected} script (wiki language: ${resolvedLang})`);
        } else {
            add('rationale_language', LEVELS.INFO, 'Rationale language',
                resolvedLang ? `not checked: ${resolvedLang} shares its script with English` : 'not checked: wiki language unknown');
        }
        if (severitySeen) {
            if (severityGaps.seen) suspects.set('severity_missing', severityGaps);
            add('severity', severityMissing ? LEVELS.WARN : LEVELS.PASS, 'Severity pass',
                `${severityMissing} of ${severityExpected} flagged model rows have neither a tier nor an error`
                + (Object.keys(severityTiers).length ? `; tiers: ${JSON.stringify(severityTiers)}` : ''));
        }

        // --- Claims ---
        const longShare = share(longClaims, claimsChecked);
        add('claim_length', longShare > thresholds.longClaimFail ? LEVELS.FAIL : longShare > thresholds.longClaimWarn ? LEVELS.WARN : LEVELS.PASS,
            'Claim length', `${longClaims} of ${claimsChecked} claims (${pct(longClaims, claimsChecked)}) are over ${thresholds.longClaimChars} characters; median ~${medianClaim()}${longShare > thresholds.longClaimWarn ? ' — sentence splitting may have failed' : ''}`);
        const junkShare = share(junkClaims, claimsChecked);
        add('junk_in_claim', junkShare > thresholds.junkClaimFail ? LEVELS.FAIL : junkClaims ? LEVELS.WARN : LEVELS.PASS,
            'Markup in claims', `${junkClaims} claim(s) contain CSS, wikitext, HTML, footnote markers or maintenance tags`);
        const tableArticles = [...perArticle.entries()]
            .filter(([, a]) => a.rows >= thresholds.tableLikeArticleMinRows && share(a.tableLike, a.rows) >= thresholds.tableLikeArticleShare)
            .map(([t, a]) => `${t} (${a.tableLike}/${a.rows})`);
        add('table_like_articles', tableArticles.length ? LEVELS.WARN : LEVELS.PASS, 'Table-like articles',
            tableArticles.length ? `${tableArticles.length} article(s) whose claims are mostly score lines or table cells: ${tableArticles.slice(0, 10).join(' · ')}`
                : 'no article is mostly table cells');

        return result();

        function medianClaim() {
            let seen = 0;
            for (const bucket of [...claimLengths.keys()].sort((a, b) => a - b)) {
                seen += claimLengths.get(bucket);
                if (seen >= claimsChecked / 2) return `${bucket * 20}–${bucket * 20 + 19} chars`;
            }
            return 'n/a';
        }

        function result() {
            const sortedTokens = tokensIn.filter(Number.isFinite).sort((a, b) => a - b);
            const at = p => (sortedTokens.length ? sortedTokens[Math.min(sortedTokens.length - 1, Math.floor(p * sortedTokens.length))] : null);
            const unavailableHosts = [...hosts.entries()].filter(([, h]) => h.modelUnavailable)
                .sort((a, b) => b[1].modelUnavailable - a[1].modelUnavailable).slice(0, 10)
                .map(([host, h]) => ({ host, modelUnavailable: h.modelUnavailable, citations: h.citations }));
            checks.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
            const status = checks.some(c => c.level === LEVELS.FAIL) ? LEVELS.FAIL
                : checks.some(c => c.level === LEVELS.WARN) ? LEVELS.WARN : LEVELS.PASS;
            return {
                status,
                checks,
                metrics: {
                    rows,
                    articles: perArticle.size,
                    wikiLang: resolvedLang,
                    verdicts,
                    errorReasons,
                    skippedReasons,
                    citationsWithUrl: withUrl,
                    fetchFailed,
                    ourFetchFailed,
                    fetchFailureKinds: fetchKinds,
                    fetched,
                    truncated,
                    modelRows,
                    quoteStatuses,
                    severityTiers,
                    tokensIn: { p50: at(0.5), p95: at(0.95), max: sortedTokens.at(-1) ?? null },
                    hostsWhereModelSaidUnavailable: unavailableHosts,
                    // Kept for comparing a later run of the same list against this one.
                    rowsPerArticle: Object.fromEntries([...perArticle.entries()].map(([t, a]) => [t, a.rows])),
                },
                suspects: [...suspects.entries()].map(([check, r]) => ({ check, count: r.seen, examples: r.items })),
                sample: SAMPLE_STRATA.map(stratum => ({ stratum, population: samples[stratum].seen, rows: samples[stratum].items })),
            };
        }
    }

    return { addRow, addMalformed, finish };
}

const LEVEL_LABEL = { fail: 'FAIL', warn: 'WARN', pass: 'PASS', info: 'INFO' };

/** The human-readable report. */
export function renderMarkdown(result, { file = null, reviewPath = null } = {}) {
    const m = result.metrics;
    const lines = [];
    lines.push(`# Sweep checks: ${result.status.toUpperCase()}`);
    lines.push('');
    lines.push(`${file ? `\`${file}\` · ` : ''}${m.rows} rows · ${m.articles} articles${m.wikiLang ? ` · ${m.wikiLang}` : ''}`);
    lines.push('');
    lines.push('```');
    for (const check of result.checks) {
        lines.push(`${LEVEL_LABEL[check.level]}  ${check.title.padEnd(28)} ${check.summary}`);
    }
    lines.push('```');

    const details = result.checks.filter(c => c.details.length);
    if (details.length) {
        lines.push('');
        for (const check of details) for (const d of check.details) lines.push(`- **${check.title}:** ${d}`);
    }

    lines.push('', '## Verdicts', '');
    lines.push(Object.entries(m.verdicts).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n} (${pct(n, m.rows)})`).join(' · '));
    if (Object.keys(m.quoteStatuses).length) {
        lines.push('', `Quote status (model rows): ${Object.entries(m.quoteStatuses).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
    }
    if (m.tokensIn.p50 !== null) lines.push('', `tokens_in: p50 ${m.tokensIn.p50} · p95 ${m.tokensIn.p95} · max ${m.tokensIn.max}`);
    if (m.hostsWhereModelSaidUnavailable.length) {
        lines.push('', 'Hosts where the model called a fetched page unavailable (bot walls, cookie pages, paywalls?): '
            + m.hostsWhereModelSaidUnavailable.map(h => `${h.host} ${h.modelUnavailable}/${h.citations}`).join(' · '));
    }

    if (result.suspects.length) {
        lines.push('', '## Suspect rows', '');
        lines.push(`Rows a row check picked out. Up to ${SUSPECT_CAP} random examples of each are in the review CSV${reviewPath ? ` (\`${reviewPath}\`)` : ''}.`, '');
        for (const { check, count, examples } of result.suspects.sort((a, b) => b.count - a.count)) {
            lines.push(`- **${check}** — ${count} row(s). e.g. ${examples.slice(0, 3).map(e => `record ${e.index} (${e.row.page_title} #${e.row.citation_number ?? '?'}): ${e.detail}`).join('; ')}`);
        }
    }
    lines.push('');
    return lines.join('\n');
}

/**
 * Rows for the review CSV: every kept suspect example, then the random
 * sample per stratum. A row picked more than once appears once, with its
 * reasons joined. `header` is the findings CSV's own header, so the review
 * file carries every original column after its three of its own.
 */
export function reviewRows(result, header) {
    const byIndex = new Map();
    const add = (index, row, reason, detail) => {
        const entry = byIndex.get(index);
        if (entry) { entry.reasons.push(reason); if (detail) entry.details.push(detail); return; }
        byIndex.set(index, { index, row, reasons: [reason], details: detail ? [detail] : [] });
    };
    for (const { check, examples } of result.suspects) {
        for (const e of [...examples].sort((a, b) => a.index - b.index)) add(e.index, e.row, `suspect:${check}`, e.detail);
    }
    for (const { stratum, rows } of result.sample) {
        for (const s of [...rows].sort((a, b) => a.index - b.index)) add(s.index, s.row, `sample:${stratum}`, null);
    }
    const columns = ['review_reason', 'review_detail', 'record', ...header];
    const body = [...byIndex.values()].map(e => [
        e.reasons.join(' '), e.details.join('; '), e.index, ...header.map(c => e.row[c] ?? ''),
    ]);
    return [columns, ...body];
}
