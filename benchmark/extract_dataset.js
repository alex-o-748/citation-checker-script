#!/usr/bin/env node
/**
 * Dataset Extraction Script
 *
 * Reads the ground truth CSV and enriches it with claim text and source content
 * by fetching Wikipedia articles and extracting the relevant data.
 *
 * Override columns (used by externally-imported rows like the v3/WMF batch):
 *   - "WMF claim text"  — when non-blank, replaces extractClaimText() output
 *   - "WMF source URL"  — when non-blank, replaces the URL discovered in the cite_note
 *   - "WMF provenance"  — when non-blank, populates the row's `provenance` field
 * When both override columns on a row are filled, the article fetch is skipped
 * for that row (the row's full identity comes from the CSV + a fresh source fetch).
 *
 * Usage: node extract_dataset.js [--dry-run] [--limit N] [--version v1|v2|v3|all]
 *
 * Output:
 *   - dataset.json: Complete enriched dataset
 *   - dataset_review.csv: CSV for manual review before benchmarking
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { extractClaimText as extractClaimTextFromRef } from '../core/claim.js';
import { classifyBody } from '../core/body-classifier.js';
import { writeWithMetadata, todayIso } from './io.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const INPUT_CSV = path.join(__dirname, '..', 'Benchmarking_data_Citations.csv');
const OUTPUT_JSON = path.join(__dirname, 'dataset.json');
const OUTPUT_REVIEW_CSV = path.join(__dirname, 'dataset_review.csv');
const PROXY_URL = 'https://publicai-proxy.alaexis.workers.dev/';

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose') || args.includes('-v');
const limitIndex = args.indexOf('--limit');
const LIMIT = limitIndex !== -1 ? parseInt(args[limitIndex + 1], 10) : null;
const versionIndex = args.indexOf('--version');
// VERSION_FILTER: 'all' | 'v1' | 'v2' | ... — restricts which dataset rows to process.
// 'all' (default) keeps everything; specific tags (e.g. 'v1') reproduce a frozen subset.
const VERSION_FILTER = versionIndex !== -1 ? args[versionIndex + 1] : 'all';

function log(msg) {
    if (VERBOSE) console.log(msg);
}

/**
 * Parse CSV content into array of objects
 */
function parseCSV(content) {
    const lines = content.trim().split('\n');
    const headers = parseCSVLine(lines[0]);

    return lines.slice(1).map((line, index) => {
        const values = parseCSVLine(line);
        const row = {};
        headers.forEach((header, i) => {
            row[header.trim()] = values[i]?.trim() || '';
        });
        row._rowIndex = index + 2; // 1-based, accounting for header
        return row;
    });
}

/**
 * Parse a single CSV line, handling quoted fields
 */
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current);
    return result;
}

/**
 * Fetch URL content with retry logic
 */
async function fetchWithRetry(url, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fetchURL(url);
        } catch (error) {
            if (attempt === maxRetries) throw error;
            const delay = Math.pow(2, attempt) * 1000;
            console.log(`  Retry ${attempt}/${maxRetries} after ${delay}ms...`);
            await sleep(delay);
        }
    }
}

/**
 * Fetch URL content
 */
function fetchURL(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;

        const request = protocol.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BenchmarkBot/1.0)' }
        }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                // Follow redirect
                fetchURL(response.headers.location).then(resolve).catch(reject);
                return;
            }

            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }

            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => resolve(data));
        });

        request.on('error', reject);
        request.setTimeout(30000, () => {
            request.destroy();
            reject(new Error('Timeout'));
        });
    });
}

/**
 * Fetch source content via proxy, with direct fetch fallback
 */
async function fetchSourceContent(url) {
    // Try proxy first
    try {
        log(`    Trying proxy fetch...`);
        const proxyUrl = `${PROXY_URL}?fetch=${encodeURIComponent(url)}`;
        const response = await fetchWithRetry(proxyUrl);
        const data = JSON.parse(response);

        if (data.content && data.content.length > 100) {
            log(`    Proxy success: ${data.content.length} chars`);
            return data.content;
        }
        log(`    Proxy returned insufficient content: ${data.content?.length || 0} chars`);
    } catch (error) {
        log(`    Proxy fetch failed: ${error.message}`);
    }

    // Try direct fetch as fallback
    try {
        log(`    Trying direct fetch...`);
        const html = await fetchWithRetry(url);

        // Basic HTML text extraction
        const textMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
                          html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
                          html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);

        if (textMatch) {
            // Strip HTML tags
            let text = textMatch[1]
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            if (text.length > 100) {
                log(`    Direct fetch success: ${text.length} chars`);
                return text.substring(0, 50000); // Limit size
            }
        }
        log(`    Direct fetch: insufficient content`);
    } catch (error) {
        log(`    Direct fetch failed: ${error.message}`);
    }

    console.log(`    Source fetch failed for: ${url.substring(0, 60)}...`);
    return null;
}

/**
 * For a given citation number, find every `.reference` element on the page
 * that displays as `[N]` and extract the prose claim text bearing each one.
 *
 * Returns an array of `{occurrence, text, containerText}` so the caller can
 * pick a specific occurrence (Wikipedia reuses citation numbers — the same
 * `[5]` can appear several times in different paragraphs).
 *
 * Per-element extraction delegates to core/claim.js so the maintenance-marker
 * stripping (PR #117) and the Range-based extraction stay in one place.
 */
export function extractClaimsForCitation(document, citationNumber) {
    const matchingRefs = [];
    document.querySelectorAll('.reference').forEach(ref => {
        const link = ref.querySelector('a');
        if (!link) return;
        const m = link.textContent.trim().match(/^\[(\d+)\]$/);
        if (m && parseInt(m[1], 10) === citationNumber) {
            matchingRefs.push(ref);
        }
    });

    return matchingRefs.map((ref, i) => {
        const text = extractClaimTextFromRef(ref);
        const container = ref.closest('p, li, td, th, dd');
        const containerText = container
            ? container.textContent.replace(/\s+/g, ' ').trim()
            : '';
        return {
            occurrence: i + 1,
            text,
            containerText,
        };
    });
}

/**
 * Extract reference URL from Wikipedia reference section
 */
function extractReferenceUrl(document, citationNumber) {
    // Best method: Find the [N] reference link and follow its href to the cite_note
    const allRefs = document.querySelectorAll('.reference a');
    for (const link of allRefs) {
        const text = link.textContent.trim();
        const match = text.match(/^\[(\d+)\]$/);
        if (match && parseInt(match[1], 10) === citationNumber) {
            const href = link.getAttribute('href');
            if (href && href.startsWith('#')) {
                const refTarget = document.getElementById(href.substring(1));
                if (refTarget) {
                    log(`    Found cite_note via reference link: ${href.substring(1)}`);
                    return extractUrlFromRef(refTarget);
                }
            }
        }
    }

    log(`    No reference link found for citation [${citationNumber}]`);
    return null;
}

/**
 * Extract the source URL from a reference element
 */
function extractUrlFromRef(refTarget) {
    // Prioritize archive links
    const archiveLink = refTarget.querySelector(
        'a[href*="web.archive.org"], a[href*="archive.today"], a[href*="archive.is"], a[href*="archive.ph"], a[href*="webcitation.org"]'
    );
    if (archiveLink) {
        log(`    Found archive link: ${archiveLink.href.substring(0, 60)}...`);
        return archiveLink.href;
    }

    // Fall back to any http link
    const links = refTarget.querySelectorAll('a[href^="http"]');
    log(`    Found ${links.length} http links in ref`);
    if (links.length === 0) return null;

    // Skip Wikipedia internal links
    for (const link of links) {
        if (!link.href.includes('wikipedia.org') && !link.href.includes('wikimedia.org')) {
            return link.href;
        }
    }

    return links[0]?.href || null;
}

/**
 * Sleep helper
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Normalize ground truth values
 */
function normalizeVerdict(verdict) {
    const v = verdict.toLowerCase().trim();
    if (v.includes('not supported') || v === 'not_supported') return 'Not supported';
    if (v.includes('partially')) return 'Partially supported';
    if (v.includes('supported')) return 'Supported';
    if (v.includes('unavailable')) return 'Source unavailable';
    return verdict;
}

/**
 * Main extraction function
 */
async function main() {
    console.log('=== Dataset Extraction Tool ===\n');

    // Read input CSV
    console.log(`Reading: ${INPUT_CSV}`);
    const csvContent = fs.readFileSync(INPUT_CSV, 'utf-8');
    let rows = parseCSV(csvContent);

    console.log(`Found ${rows.length} rows`);

    if (VERSION_FILTER !== 'all') {
        const before = rows.length;
        // Treat rows with no Dataset version as 'v1' for backwards compatibility
        // with CSVs predating the column.
        rows = rows.filter(r => (r['Dataset version'] || 'v1') === VERSION_FILTER);
        console.log(`Filtered to dataset version "${VERSION_FILTER}": ${rows.length}/${before} rows`);
    }

    if (LIMIT) {
        rows = rows.slice(0, LIMIT);
        console.log(`Limited to ${LIMIT} rows`);
    }

    // Group by article URL to minimize fetches
    const articleGroups = new Map();
    rows.forEach(row => {
        const url = row['Article'] || row['Artice']; // Support both column names
        if (!articleGroups.has(url)) {
            articleGroups.set(url, []);
        }
        articleGroups.get(url).push(row);
    });

    console.log(`\nProcessing ${articleGroups.size} unique articles...\n`);

    const dataset = [];
    const articleCache = new Map();

    for (const [articleUrl, articleRows] of articleGroups) {
        console.log(`\nArticle: ${articleUrl.split('title=')[1]?.split('&')[0] || articleUrl}`);

        // If every row in this article group has BOTH WMF override columns filled,
        // we can skip the article fetch entirely — claim text and source URL come
        // from the CSV directly. Used for externally-imported rows (v3 / WMF dataset)
        // where the row's audited claim_text differs from what extractClaimText() would
        // produce and the audited source_url is the canonical citation target.
        const allRowsHaveFullOverride = articleRows.every(r =>
            (r['WMF claim text'] || '').trim() && (r['WMF source URL'] || '').trim()
        );

        // Fetch article HTML (with caching) unless every row is fully overridden.
        let document = null;
        if (allRowsHaveFullOverride) {
            log('  All rows have WMF overrides — skipping article fetch');
        } else if (articleCache.has(articleUrl)) {
            document = articleCache.get(articleUrl);
        } else {
            if (DRY_RUN) {
                console.log('  [DRY RUN] Would fetch article');
                continue;
            }

            try {
                console.log('  Fetching article...');
                const html = await fetchWithRetry(articleUrl);
                const dom = new JSDOM(html);
                document = dom.window.document;
                articleCache.set(articleUrl, document);

                // Diagnostic: show what we found
                const citeNotes = document.querySelectorAll('[id^="cite_note"]');
                const citeRefs = document.querySelectorAll('[id^="cite_ref"]');
                const references = document.querySelectorAll('.reference');
                const reflist = document.querySelectorAll('.reflist li, .references li');
                log(`  Found: ${citeNotes.length} cite_note, ${citeRefs.length} cite_ref, ${references.length} .reference, ${reflist.length} reflist items`);

                if (VERBOSE && citeNotes.length === 0 && reflist.length > 0) {
                    // Show first few reflist item IDs
                    const ids = Array.from(reflist).slice(0, 5).map(el => el.id || '(no id)');
                    log(`  Reflist sample IDs: ${ids.join(', ')}`);
                }

                await sleep(1000); // Rate limiting
            } catch (error) {
                console.log(`  ERROR fetching article: ${error.message}`);
                // Add rows with error status
                for (const row of articleRows) {
                    dataset.push({
                        id: `row_${row._rowIndex}`,
                        article_url: articleUrl,
                        citation_number: parseInt(row['Citation number'], 10),
                        occurrence: 1,
                        claim_text: '',
                        source_url: '',
                        source_text: '',
                        ground_truth: normalizeVerdict(row['Ground truth']),
                        dataset_version: row['Dataset version'] || 'v1',
                        extraction_status: 'article_fetch_failed',
                        needs_manual_review: true
                    });
                }
                continue;
            }
        }

        // Process each citation in this article
        for (const row of articleRows) {
            const citationNumber = parseInt(row['Citation number'], 10);
            // Use explicit "Citation instance" from CSV instead of auto-counting
            const occurrence = parseInt(row['Citation instance'], 10) || 1;
            const wmfClaimText = (row['WMF claim text'] || '').trim();
            const wmfSourceUrl = (row['WMF source URL'] || '').trim();
            const wmfProvenance = (row['WMF provenance'] || '').trim();

            console.log(`  Citation [${citationNumber}] (instance ${occurrence})...`);

            // Claim text: WMF override takes precedence; otherwise extract from article.
            let claimText, claimContainer, totalOccurrences;
            if (wmfClaimText) {
                claimText = wmfClaimText;
                claimContainer = '';
                totalOccurrences = null;
            } else {
                const claims = extractClaimsForCitation(document, citationNumber);
                const claimData = claims[occurrence - 1] || claims[0] || { text: '', occurrence: 1 };
                claimText = claimData.text;
                claimContainer = claimData.containerText || '';
                totalOccurrences = claims.length;
            }

            // Source URL: WMF override takes precedence; otherwise extract from article.
            const sourceUrl = wmfSourceUrl || (document ? extractReferenceUrl(document, citationNumber) : null);

            // Fetch source content
            let sourceText = '';
            let bodyUnusableReason = null;
            if (sourceUrl && !DRY_RUN) {
                console.log(`    Fetching source: ${sourceUrl.substring(0, 60)}...`);
                sourceText = await fetchSourceContent(sourceUrl) || '';
                if (sourceText) {
                    // Mechanically detect structurally-bad bodies (Wayback chrome,
                    // CSS leak, JSON-LD blob, anti-bot challenge, etc.) so the
                    // benchmark records SU deterministically without invoking
                    // an LLM. The bad text is preserved in source_text for
                    // future audit / pattern re-tuning.
                    const classification = classifyBody(sourceText);
                    if (!classification.usable) {
                        bodyUnusableReason = classification.reason;
                        console.log(`    Body classified unusable: ${classification.reason} (${sourceText.length} chars preserved for audit)`);
                    }
                }
                await sleep(500); // Rate limiting
            }

            const entry = {
                id: `row_${row._rowIndex}`,
                article_url: articleUrl,
                article_title: articleUrl.split('title=')[1]?.split('&')[0]?.replace(/_/g, ' ') || '',
                citation_number: citationNumber,
                occurrence: occurrence,
                total_occurrences: totalOccurrences,
                claim_text: claimText,
                claim_container: claimContainer,
                source_url: sourceUrl || '',
                source_text: sourceText,
                ground_truth: normalizeVerdict(row['Ground truth']),
                dataset_version: row['Dataset version'] || 'v1',
                extraction_status: bodyUnusableReason
                    ? 'body_unusable'
                    : determineStatus(claimText, sourceUrl, sourceText),
                ...(bodyUnusableReason ? { body_unusable_reason: bodyUnusableReason } : {}),
                needs_manual_review: !claimText || (!sourceText && !bodyUnusableReason),
                ...(wmfProvenance ? { provenance: wmfProvenance } : {}),
            };

            dataset.push(entry);
        }
    }

    if (DRY_RUN) {
        console.log('\n[DRY RUN] No files written');
        return;
    }

    // Write JSON output with metadata header so downstream runs can attribute
    // their results to a specific extraction date. See benchmark/README.md
    // "Reproducibility metadata" for the schema.
    console.log(`\nWriting: ${OUTPUT_JSON}`);
    const datasetMetadata = {
        extracted_at: todayIso(),
        version_filter: VERSION_FILTER
    };
    writeWithMetadata(OUTPUT_JSON, datasetMetadata, dataset);

    // Write review CSV
    console.log(`Writing: ${OUTPUT_REVIEW_CSV}`);
    writeReviewCSV(dataset);

    // Summary
    const needsReview = dataset.filter(d => d.needs_manual_review).length;
    const complete = dataset.filter(d => !d.needs_manual_review).length;
    const bodyUnusable = dataset.filter(d => d.extraction_status === 'body_unusable').length;
    const bodyUnusableByReason = dataset
        .filter(d => d.extraction_status === 'body_unusable')
        .reduce((acc, d) => {
            const r = d.body_unusable_reason || 'unknown';
            acc[r] = (acc[r] || 0) + 1;
            return acc;
        }, {});

    console.log('\n=== Summary ===');
    console.log(`Total entries: ${dataset.length}`);
    console.log(`Complete: ${complete}`);
    console.log(`Needs manual review: ${needsReview}`);
    console.log(`Body unusable (pipeline-attributed SU): ${bodyUnusable}`);
    if (bodyUnusable > 0) {
        for (const [reason, count] of Object.entries(bodyUnusableByReason)) {
            console.log(`  - ${reason}: ${count}`);
        }
    }

    if (needsReview > 0) {
        console.log(`\nReview the entries in ${OUTPUT_REVIEW_CSV} before running benchmarks.`);
    }
}

/**
 * Determine extraction status. Note: 'body_unusable' is set by the caller
 * before this is consulted, when the body-classifier flags structurally-bad
 * extracted content (Wayback chrome, CSS leak, etc.).
 */
function determineStatus(claimText, sourceUrl, sourceText) {
    if (!claimText) return 'claim_extraction_failed';
    if (!sourceUrl) return 'no_source_url';
    if (!sourceText) return 'source_fetch_failed';
    return 'complete';
}

/**
 * Write review CSV for manual verification
 */
function writeReviewCSV(dataset) {
    const headers = [
        'id',
        'article_title',
        'citation_number',
        'occurrence',
        'claim_text',
        'source_url',
        'source_text_preview',
        'ground_truth',
        'dataset_version',
        'extraction_status',
        'needs_manual_review',
        'manual_claim_override',
        'manual_source_override'
    ];

    const rows = dataset.map(entry => [
        entry.id,
        entry.article_title,
        entry.citation_number,
        entry.occurrence,
        `"${(entry.claim_text || '').replace(/"/g, '""').substring(0, 500)}"`,
        entry.source_url,
        `"${(entry.source_text || '').replace(/"/g, '""').substring(0, 200)}..."`,
        entry.ground_truth,
        entry.dataset_version || 'v1',
        entry.extraction_status,
        entry.needs_manual_review,
        '', // manual_claim_override - to be filled by reviewer
        ''  // manual_source_override - to be filled by reviewer
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    fs.writeFileSync(OUTPUT_REVIEW_CSV, csv);
}

// Run only when invoked as a script, not when imported by tests or other modules
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(console.error);
}
