// Entry point for the `ccs` CLI. Owns argv parsing, Wikipedia REST
// fetching, JSDOM parsing, dispatch into core/, exit-code classification,
// and stdout formatting. core/ owns the pure logic; this file is the only
// place that does I/O.

import { parseArgs } from 'node:util';
import { JSDOM } from 'jsdom';
import { extractClaimText } from '../core/claim.js';
import { extractReferenceUrl, extractPageNumber } from '../core/urls.js';
import { logVerification } from '../core/worker.js';
import { modelFor } from '../core/models.js';
import { verifyCitation, VERIFY_STAGES } from '../core/pipeline.js';
import { parseCompareArgs, COMPARE_HELP_TEXT, runCompare } from './compare.js';

const KNOWN_PROVIDERS = ['publicai', 'huggingface', 'liftwing', 'claude', 'gemini', 'openai'];

// Experimental: opt-in override that routes the huggingface/liftwing
// providers' proxy calls through the tf-llm-router Toolforge tool
// (https://github.com/alex-o-748/tf-llm-router) instead of the Cloudflare
// Worker CORS proxy, mirroring the same override in main.js
// (useToolforgeLlmRouter). Unlike tf-source-fetcher, tf-llm-router's README
// carries no WMCS gating caveat — it's opt-in because it's new and its
// Toolforge rate-limit behavior is still unverified, not because it's
// policy-blocked. liftwing benefits from this the most: Lift Wing is
// severely rate-limited when called from outside Wikimedia infrastructure
// (as this CLI does by default) but not when called from inside Toolforge,
// which is exactly what routing through tf-llm-router does (see
// docs/design-plans/2026-08-07-batch-source-checks-for-edit-suggestions.md
// §5). Only applies to huggingface/liftwing routed via the proxy (no
// HF_API_KEY set for huggingface — with a key the call goes directly to HF's
// router and workerBase is irrelevant); publicai isn't routed here at all,
// since tf-llm-router doesn't implement a publicai-shaped route.
const TOOLFORGE_LLM_ROUTER_BASE = 'https://llm-router.toolforge.org';

export function parseCliArgs(argv) {
    const raw = argv.slice(2);

    if (raw.length === 0) return { help: true, scope: 'top' };
    if (raw[0] === '-h' || raw[0] === '--help') return { help: true, scope: 'top' };

    const subcommand = raw[0];
    const subArgs = raw.slice(1);

    if (subcommand === 'verify') {
        const opts = parseVerifyArgs(subArgs);
        return { ...opts, subcommand: 'verify' };
    }
    if (subcommand === 'compare') {
        const opts = parseCompareArgs(subArgs);
        return { ...opts, subcommand: 'compare' };
    }

    throw new UsageError(`unknown subcommand: ${subcommand}`);
}

function parseVerifyArgs(args) {
    if (args.includes('-h') || args.includes('--help')) {
        return { help: true, scope: 'verify' };
    }

    const { values, positionals } = parseArgs({
        args,
        options: {
            provider: { type: 'string', default: 'huggingface' },
            'no-log': { type: 'boolean', default: false },
            'live-llm-router': { type: 'boolean', default: false },
            help:     { type: 'boolean', short: 'h', default: false },
        },
        allowPositionals: true,
        strict: true,
    });

    const url = positionals[0];
    const citationStr = positionals[1];
    if (!url || !citationStr) {
        throw new UsageError('usage: ccs verify <wikipedia-url> <citation-number> [--provider <name>] [--no-log]');
    }

    const citationNumber = Number(citationStr);
    if (!Number.isInteger(citationNumber) || citationNumber < 1) {
        throw new UsageError(`citation number must be a positive integer (got: ${citationStr})`);
    }

    const provider = values.provider;
    if (!KNOWN_PROVIDERS.includes(provider)) {
        throw new UsageError(`unknown provider: ${provider} (choose from: ${KNOWN_PROVIDERS.join(', ')})`);
    }

    return {
        help: false,
        url,
        citationNumber,
        provider,
        noLog: values['no-log'],
        liveLlmRouter: values['live-llm-router'],
    };
}

export class UsageError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UsageError';
    }
}

export function parseWikiUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new UsageError(`invalid URL: ${rawUrl}`);
    }

    if (parsed.hostname !== 'en.wikipedia.org') {
        throw new UsageError(`URL must be an en.wikipedia.org article URL (got host: ${parsed.hostname})`);
    }

    if (!parsed.pathname.startsWith('/wiki/')) {
        throw new UsageError(`URL must be the /wiki/<title> form (got path: ${parsed.pathname})`);
    }

    const encodedTitle = parsed.pathname.slice('/wiki/'.length);
    if (!encodedTitle) {
        throw new UsageError(`could not extract article title from URL: ${rawUrl}`);
    }

    const title = decodeURIComponent(encodedTitle);
    const oldid = parsed.searchParams.get('oldid');

    return { title, oldid };
}

export function deriveRestUrl({ title, oldid }) {
    // encodeURIComponent percent-encodes '/' but leaves '(' ')' alone —
    // both desirable for the REST API path segment.
    const encodedTitle = encodeURIComponent(title);
    const base = `https://en.wikipedia.org/api/rest_v1/page/html/${encodedTitle}`;
    return oldid ? `${base}/${oldid}` : base;
}

export function findReferenceByCitationNumber(document, citationNumber) {
    const target = `[${citationNumber}]`;
    const refs = document.querySelectorAll('sup.reference');
    for (const ref of refs) {
        if (ref.textContent.replace(/\s+/g, '') === target) {
            return ref;
        }
    }
    return null;
}

// COUPLING NOTE: This function parses exit codes out of the string format
// that core/providers.js uses for its error messages ("API request failed
// (<status>): ..." and "Invalid API response format"). If someone rewords
// those messages in core/providers.js, this function silently stops
// mapping to the right exit code. A typed-error refactor across core/ is
// the proper long-term fix; until then, keep this and core/providers.js
// in sync.
export function classifyProviderError(err) {
    const message = err?.message || '';
    if (/Invalid API response format|ran out of output budget/i.test(message)) return 11;
    const statusMatch = message.match(/\((\d{3})\)/);
    if (statusMatch) {
        const status = Number(statusMatch[1]);
        if (status >= 400 && status < 500) return 9;
        if (status >= 500) return 10;
    }
    // No status in message => treat as network/5xx-class failure.
    return 10;
}

const PROVIDER_ENV_VARS = {
    publicai:    null, // routed through the worker proxy; no client-side key
    huggingface: null, // proxy by default; HF_API_KEY (optional) opts into direct
    liftwing:    null, // proxy-only; no client-side key
    claude:      'CLAUDE_API_KEY',
    gemini:      'GEMINI_API_KEY',
    openai:      'OPENAI_API_KEY',
};

// Optional env vars: when present, switch the provider to a direct-call path.
// Absent is fine — the call falls back to PROVIDER_ENV_VARS' default routing.
const PROVIDER_OPTIONAL_ENV_VARS = {
    huggingface: 'HF_API_KEY',
};

export const VERIFY_HELP_TEXT = `usage: ccs verify <wikipedia-url> <citation-number> [options]

Verify a Wikipedia citation by fetching its source and asking an LLM
whether the cited claim is supported.

Arguments:
  <wikipedia-url>    An https://en.wikipedia.org/wiki/<Title> URL.
                     Optional ?oldid=<rev> query param pins a revision.
  <citation-number>  The [N] bracketed reference number as it appears
                     in the rendered article (positive integer).

Options:
  --provider <name>  LLM provider to use. One of:
                       huggingface (default; routed via the worker proxy,
                                    no API key needed; set HF_API_KEY to
                                    call HF directly and unlock any
                                    HF-hosted model)
                       publicai    (routed via the worker proxy,
                                    no API key needed)
                       liftwing    (Wikimedia Lift Wing, routed via the
                                    worker proxy, no API key needed; see
                                    --live-llm-router — Lift Wing is
                                    severely rate-limited from outside
                                    Wikimedia infrastructure)
                       claude      (requires CLAUDE_API_KEY)
                       gemini      (requires GEMINI_API_KEY)
                       openai      (requires OPENAI_API_KEY)
  --no-log           Do not log the verification to the worker proxy's
                     /log endpoint.
  --live-llm-router  Route the huggingface/liftwing providers through
                     tf-llm-router (https://github.com/alex-o-748/tf-llm-router)
                     instead of the Cloudflare Worker proxy. Experimental; no
                     effect unless --provider is huggingface (with HF_API_KEY
                     unset) or liftwing.
  --help, -h         Show this help and exit.

Exit codes:
  0   success
  2   bad command-line arguments
  3   Wikipedia article not found (404)
  4   Wikipedia fetch failed (5xx or network error)
  5   citation number not present in article
  6   citation has no fetchable source URL
  7   source unavailable (fetch returned empty or the URL was unfetchable)
  8   required API key environment variable is missing
  9   provider returned a 4xx (auth error, rate limit, bad request)
  10  provider returned a 5xx or network error
  11  LLM returned malformed JSON

Examples:
  ccs verify https://en.wikipedia.org/wiki/Great_Migration_(African_American) 14
  ccs verify https://en.wikipedia.org/wiki/Foo 3 --provider claude
  ccs verify https://en.wikipedia.org/wiki/Foo?oldid=1234567 3 --no-log
  ccs verify https://en.wikipedia.org/wiki/Foo 3 --live-llm-router
`;

export const TOP_LEVEL_HELP_TEXT = `usage: ccs <subcommand> [...]

Subcommands:
  verify    Verify a Wikipedia citation by fetching its source and asking
            an LLM whether the cited claim is supported.
  compare   Compare two benchmark results.json files and produce a
            per-provider accuracy + flip report (Markdown, HTML, or JSON).

Run \`ccs <subcommand> --help\` for subcommand-specific options.
`;

async function fetchWikipediaHtml(restUrl) {
    const response = await fetch(restUrl, {
        headers: {
            'User-Agent': 'ccs-cli (https://github.com/alex-o-748/citation-checker-script)',
            'Accept': 'text/html',
        },
    });

    if (response.status === 404) {
        const err = new Error(`Wikipedia article not found (404): ${restUrl}`);
        err.exitCode = 3;
        throw err;
    }
    if (!response.ok) {
        const err = new Error(`Wikipedia fetch failed (${response.status}): ${restUrl}`);
        err.exitCode = 4;
        throw err;
    }
    return await response.text();
}

export async function runVerify(opts, { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
    const { url, citationNumber, provider, noLog, liveLlmRouter } = opts;

    // 1. Check API key availability up-front (exit 8).
    const envVar = PROVIDER_ENV_VARS[provider];
    if (envVar && !env[envVar]) {
        stderr.write(`ccs: ${envVar} environment variable is required for provider "${provider}"\n`);
        return 8;
    }

    // 2. Parse the article URL and derive the REST URL.
    let parsedWikiUrl, restUrl;
    try {
        parsedWikiUrl = parseWikiUrl(url);
        restUrl = deriveRestUrl(parsedWikiUrl);
    } catch (err) {
        stderr.write(`ccs: ${err.message}\n`);
        return 2;
    }

    // 3. Fetch the article HTML.
    let html;
    try {
        html = await fetchWikipediaHtml(restUrl);
    } catch (err) {
        stderr.write(`ccs: ${err.message}\n`);
        return err.exitCode ?? 4;
    }

    // 4. Parse with JSDOM. The `url` option lets relative hrefs resolve.
    const dom = new JSDOM(html, { url });
    const document = dom.window.document;

    // 5. Locate the citation reference element.
    const refSup = findReferenceByCitationNumber(document, citationNumber);
    if (!refSup) {
        stderr.write(`ccs: no citation [${citationNumber}] found in article\n`);
        return 5;
    }
    const refAnchor = refSup.querySelector('a');
    if (!refAnchor) {
        stderr.write(`ccs: citation [${citationNumber}] has no anchor element\n`);
        return 5;
    }

    // 6. Extract the claim text.
    const claim = extractClaimText(refSup);
    if (!claim) {
        stderr.write(`ccs: could not extract claim text for citation [${citationNumber}]\n`);
        return 5;
    }

    // 7. Extract the source URL and page number. Phase 1 of this plan
    //    refactored core/urls.js to take `document` as an explicit param,
    //    so no global shim is needed.
    const sourceUrl = extractReferenceUrl(refAnchor, document);
    const pageNum = extractPageNumber(refAnchor, document);
    if (!sourceUrl) {
        stderr.write(`ccs: citation [${citationNumber}] has no fetchable URL\n`);
        return 6;
    }

    // 8-10. Fetch the source, prompt the model, parse the verdict and check
    //       the quote — all of it core/pipeline.js's verifyCitation(), which
    //       the userscript and the standalone web tool run too. This file
    //       keeps only what is CLI-specific: env-var key lookup, the
    //       tf-llm-router override, exit codes, and stdout formatting.
    const optionalEnvVar = PROVIDER_OPTIONAL_ENV_VARS[provider];
    const apiKey = envVar
        ? env[envVar]
        : (optionalEnvVar ? env[optionalEnvVar] : undefined);

    // See TOOLFORGE_LLM_ROUTER_BASE above: only meaningful for the proxy-routed
    // huggingface/liftwing calls (no apiKey — a direct HF call ignores
    // workerBase entirely, and liftwing never takes a client-side key).
    let workerBase;
    if (liveLlmRouter && (provider === 'huggingface' || provider === 'liftwing') && !apiKey) {
        stderr.write(`ccs: routing ${provider} via ${TOOLFORGE_LLM_ROUTER_BASE}\n`);
        workerBase = TOOLFORGE_LLM_ROUTER_BASE;
    }

    const result = await verifyCitation({
        claimText: claim,
        sourceUrl,
        pageNum,
        provider,
        model: modelFor(provider),
        apiKey,
        workerBase,
    });

    if (!result.ok) {
        if (result.stage === VERIFY_STAGES.SOURCE) {
            const detail = result.status != null ? ` (HTTP ${result.status})` : '';
            const reason = result.error ? `: ${result.error}` : '';
            stderr.write(`ccs: source unavailable${detail}${reason}\n  url: ${sourceUrl}\n`);
            return 7;
        }
        if (result.stage === VERIFY_STAGES.PROVIDER) {
            stderr.write(`ccs: provider call failed: ${result.error}\n`);
            return classifyProviderError(result.cause);
        }
        stderr.write(`ccs: LLM returned malformed JSON. Raw (first 200 chars): ${result.raw.slice(0, 200)}\n`);
        return 11;
    }

    // 11. Log (fire-and-forget).
    if (!noLog) {
        const articleTitle = parsedWikiUrl.title.replace(/_/g, ' ');
        logVerification({
            article_url: url,
            article_title: articleTitle,
            citation_number: String(citationNumber),
            source_url: sourceUrl,
            provider,
            verdict: result.verdict,
            // Wire/column name stays `confidence` (see core/feedback.js's
            // buildLogPayload) — it's the Neon column, unmigrated for now.
            confidence: result.supportScore,
        });
    }

    // 12. Print the result. The quote is printed only once it has been found
    //     in the fetched source (core/quote.js) — an unlocated quote is
    //     reported as such rather than shown.
    stdout.write(`Verdict:    ${result.verdict}\n`);
    stdout.write(`Support score: ${result.supportScore ?? 'n/a'}\n`);
    stdout.write(`Claim:      ${claim}\n`);
    stdout.write(`Source:     ${sourceUrl}\n`);
    if (result.sourceQuote) {
        stdout.write(result.quote.verified
            ? `Quote:      "${result.sourceQuote}"\n`
            : `Quote:      (not found in source: ${result.quote.status})\n`);
    }
    stdout.write(`\n${result.comments}\n`);
    return 0;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
    let opts;
    try {
        opts = parseCliArgs(argv);
    } catch (err) {
        if (err instanceof UsageError) {
            stderr.write(`ccs: ${err.message}\n`);
            return 2;
        }
        throw err;
    }

    if (opts.help) {
        if (opts.scope === 'verify') {
            stdout.write(VERIFY_HELP_TEXT);
        } else if (opts.scope === 'compare') {
            stdout.write(COMPARE_HELP_TEXT);
        } else {
            stdout.write(TOP_LEVEL_HELP_TEXT);
        }
        return 0;
    }

    if (opts.subcommand === 'verify') {
        return await runVerify(opts, { stdout, stderr, env });
    }

    if (opts.subcommand === 'compare') {
        return await runCompare(opts, { stdout, stderr });
    }

    // Unreachable — parseCliArgs would have thrown.
    throw new Error(`unhandled subcommand: ${opts.subcommand}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv).then((code) => process.exit(code));
}
