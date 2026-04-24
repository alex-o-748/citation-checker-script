// Entry point for the `ccs` CLI. Owns argv parsing, Wikipedia REST
// fetching, JSDOM parsing, dispatch into core/, exit-code classification,
// and stdout formatting. core/ owns the pure logic; this file is the only
// place that does I/O.

import { parseArgs } from 'node:util';
import { JSDOM } from 'jsdom';
import { extractClaimText } from '../core/claim.js';
import { extractReferenceUrl, extractPageNumber } from '../core/urls.js';
import { fetchSourceContent, logVerification } from '../core/worker.js';
import { generateSystemPrompt, generateUserPrompt } from '../core/prompts.js';
import { callProviderAPI } from '../core/providers.js';
import { parseVerificationResult } from '../core/parsing.js';

const KNOWN_PROVIDERS = ['publicai', 'claude', 'gemini', 'openai'];

export function parseCliArgs(argv) {
    const raw = argv.slice(2);

    if (raw.length === 0) {
        return { help: true };
    }

    const { values, positionals } = parseArgs({
        args: raw,
        options: {
            provider: { type: 'string', default: 'publicai' },
            'no-log': { type: 'boolean', default: false },
            help:     { type: 'boolean', short: 'h', default: false },
        },
        allowPositionals: true,
        strict: true,
    });

    if (values.help) {
        return { help: true };
    }

    const subcommand = positionals[0];
    if (!subcommand) {
        return { help: true };
    }
    if (subcommand !== 'verify') {
        throw new UsageError(`unknown subcommand: ${subcommand}`);
    }

    const url = positionals[1];
    const citationStr = positionals[2];
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
        subcommand: 'verify',
        url,
        citationNumber,
        provider,
        noLog: values['no-log'],
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
    if (/Invalid API response format/i.test(message)) return 11;
    const statusMatch = message.match(/\((\d{3})\)/);
    if (statusMatch) {
        const status = Number(statusMatch[1]);
        if (status >= 400 && status < 500) return 9;
        if (status >= 500) return 10;
    }
    // No status in message => treat as network/5xx-class failure.
    return 10;
}

const PROVIDER_MODELS = {
    publicai: 'aisingapore/Qwen-SEA-LION-v4-32B-IT',
    claude:   'claude-sonnet-4-6',
    gemini:   'gemini-flash-latest',
    openai:   'gpt-4o',
};

const PROVIDER_ENV_VARS = {
    publicai: null, // routed through the worker proxy; no client-side key
    claude:   'CLAUDE_API_KEY',
    gemini:   'GEMINI_API_KEY',
    openai:   'OPENAI_API_KEY',
};

export const HELP_TEXT = `usage: ccs verify <wikipedia-url> <citation-number> [options]

Verify a Wikipedia citation by fetching its source and asking an LLM
whether the cited claim is supported.

Arguments:
  <wikipedia-url>    An https://en.wikipedia.org/wiki/<Title> URL.
                     Optional ?oldid=<rev> query param pins a revision.
  <citation-number>  The [N] bracketed reference number as it appears
                     in the rendered article (positive integer).

Options:
  --provider <name>  LLM provider to use. One of:
                       publicai (default; routed via the worker proxy,
                                 no API key needed)
                       claude   (requires CLAUDE_API_KEY)
                       gemini   (requires GEMINI_API_KEY)
                       openai   (requires OPENAI_API_KEY)
  --no-log           Do not log the verification to the worker proxy's
                     /log endpoint.
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
    const { url, citationNumber, provider, noLog } = opts;

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

    // 8. Fetch the source content via the worker proxy.
    const sourceInfo = await fetchSourceContent(sourceUrl, pageNum);
    if (!sourceInfo) {
        stderr.write(`ccs: source unavailable: ${sourceUrl}\n`);
        return 7;
    }

    // 9. Build prompts and call the LLM.
    //    fetchSourceContent returns a string shaped "Source URL: <u>\n\n
    //    Source Content:\n<body>"; generateUserPrompt parses that shape,
    //    so we pass it through unchanged.
    //    callProviderAPI returns { text, usage } on success; extra keys in
    //    providerConfig are ignored by the destructure so it's safe to
    //    include apiKey for publicai (which won't read it).
    const systemPrompt = generateSystemPrompt();
    const userContent = generateUserPrompt(claim, sourceInfo);
    const providerConfig = {
        model: PROVIDER_MODELS[provider],
        systemPrompt,
        userContent,
        apiKey: envVar ? env[envVar] : undefined,
    };

    let providerResult;
    try {
        providerResult = await callProviderAPI(provider, providerConfig);
    } catch (err) {
        stderr.write(`ccs: provider call failed: ${err.message}\n`);
        return classifyProviderError(err);
    }

    // 10. Parse the verdict.
    const verdict = parseVerificationResult(providerResult.text);
    if (verdict.verdict === 'ERROR') {
        stderr.write(`ccs: LLM returned malformed JSON. Raw (first 200 chars): ${providerResult.text.slice(0, 200)}\n`);
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
            verdict: verdict.verdict,
            confidence: verdict.confidence,
        });
    }

    // 12. Print the result.
    stdout.write(`Verdict:    ${verdict.verdict}\n`);
    stdout.write(`Confidence: ${verdict.confidence ?? 'n/a'}\n`);
    stdout.write(`Claim:      ${claim}\n`);
    stdout.write(`Source:     ${sourceUrl}\n`);
    stdout.write(`\n${verdict.comments}\n`);
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
        stdout.write(HELP_TEXT);
        return 0;
    }

    return await runVerify(opts, { stdout, stderr, env });
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv).then((code) => process.exit(code));
}
