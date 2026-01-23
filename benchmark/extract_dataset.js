#!/usr/bin/env node
/**
 * Dataset Extraction Script
 *
 * Reads the ground truth CSV and enriches it with claim text and source content
 * by fetching Wikipedia articles and extracting the relevant data.
 *
 * Usage: node extract_dataset.js [--dry-run] [--limit N]
 *
 * Output:
 *   - dataset.json: Complete enriched dataset
 *   - dataset_review.csv: CSV for manual review before benchmarking
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { JSDOM } = require('jsdom');

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
        const protocol = url.startsWith('https') ? https : require('http');

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
 * Extract claim text for a specific citation from Wikipedia HTML
 */
function extractClaimText(document, citationNumber) {
    // Find all references with this citation number
    const allRefs = document.querySelectorAll('.reference');
    const matchingRefs = [];

    allRefs.forEach(ref => {
        const link = ref.querySelector('a');
        if (link) {
            const text = link.textContent.trim();
            // Match [N] pattern
            const match = text.match(/^\[(\d+)\]$/);
            if (match && parseInt(match[1], 10) === citationNumber) {
                matchingRefs.push(ref);
            }
        }
    });

    return matchingRefs.map((ref, occurrenceIndex) => {
        const container = ref.closest('p, li, td, th, dd');
        if (!container) {
            return { occurrence: occurrenceIndex + 1, text: '', container: null };
        }

        // Get all references in this container
        const refsInContainer = Array.from(container.querySelectorAll('.reference'));
        const currentIndex = refsInContainer.indexOf(ref);

        // Simple extraction: get text before this reference
        let text = '';

        if (currentIndex === 0) {
            // First reference in container - get all text up to this ref
            text = getTextBeforeElement(container, ref);
        } else {
            // Get text between previous ref and this one
            const prevRef = refsInContainer[currentIndex - 1];
            text = getTextBetweenElements(container, prevRef, ref);
        }

        // Clean up
        text = text
            .replace(/\[\d+\]/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        // Fallback to container text if extraction failed
        if (!text || text.length < 10) {
            text = container.textContent
                .replace(/\[\d+\]/g, '')
                .replace(/\s+/g, ' ')
                .trim();
        }

        return {
            occurrence: occurrenceIndex + 1,
            text: text,
            containerText: container.textContent.replace(/\s+/g, ' ').trim()
        };
    });
}

/**
 * Get text content before a specific element within a container
 */
function getTextBeforeElement(container, element) {
    let text = '';
    const walker = container.ownerDocument.createTreeWalker(
        container,
        4, // NodeFilter.SHOW_TEXT
        null
    );

    let node;
    while ((node = walker.nextNode())) {
        if (element.contains(node) || isAfterElement(node, element)) {
            break;
        }
        text += node.textContent;
    }
    return text;
}

/**
 * Get text content between two elements
 */
function getTextBetweenElements(container, startElement, endElement) {
    let text = '';
    let capturing = false;

    const walker = container.ownerDocument.createTreeWalker(
        container,
        4, // NodeFilter.SHOW_TEXT
        null
    );

    let node;
    while ((node = walker.nextNode())) {
        if (startElement.contains(node)) {
            capturing = true;
            continue;
        }
        if (endElement.contains(node)) {
            break;
        }
        if (capturing) {
            text += node.textContent;
        }
    }
    return text;
}

/**
 * Check if node comes after element in document order
 */
function isAfterElement(node, element) {
    const position = node.compareDocumentPosition(element);
    return (position & 2) !== 0; // DOCUMENT_POSITION_PRECEDING
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

        // Fetch article HTML (with caching)
        let document;
        if (articleCache.has(articleUrl)) {
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

            console.log(`  Citation [${citationNumber}] (instance ${occurrence})...`);

            // Extract claim text
            const claims = extractClaimText(document, citationNumber);
            const claimData = claims[occurrence - 1] || claims[0] || { text: '', occurrence: 1 };

            // Extract reference URL
            const sourceUrl = extractReferenceUrl(document, citationNumber);

            // Fetch source content
            let sourceText = '';
            if (sourceUrl && !DRY_RUN) {
                console.log(`    Fetching source: ${sourceUrl.substring(0, 60)}...`);
                sourceText = await fetchSourceContent(sourceUrl) || '';
                await sleep(500); // Rate limiting
            }

            const entry = {
                id: `row_${row._rowIndex}`,
                article_url: articleUrl,
                article_title: articleUrl.split('title=')[1]?.split('&')[0]?.replace(/_/g, ' ') || '',
                citation_number: citationNumber,
                occurrence: occurrence,
                total_occurrences: claims.length,
                claim_text: claimData.text,
                claim_container: claimData.containerText || '',
                source_url: sourceUrl || '',
                source_text: sourceText,
                ground_truth: normalizeVerdict(row['Ground truth']),
                extraction_status: determineStatus(claimData.text, sourceUrl, sourceText),
                needs_manual_review: !claimData.text || !sourceText
            };

            dataset.push(entry);
        }
    }

    if (DRY_RUN) {
        console.log('\n[DRY RUN] No files written');
        return;
    }

    // Write JSON output
    console.log(`\nWriting: ${OUTPUT_JSON}`);
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(dataset, null, 2));

    // Write review CSV
    console.log(`Writing: ${OUTPUT_REVIEW_CSV}`);
    writeReviewCSV(dataset);

    // Summary
    const needsReview = dataset.filter(d => d.needs_manual_review).length;
    const complete = dataset.filter(d => !d.needs_manual_review).length;

    console.log('\n=== Summary ===');
    console.log(`Total entries: ${dataset.length}`);
    console.log(`Complete: ${complete}`);
    console.log(`Needs manual review: ${needsReview}`);

    if (needsReview > 0) {
        console.log(`\nReview the entries in ${OUTPUT_REVIEW_CSV} before running benchmarks.`);
    }
}

/**
 * Determine extraction status
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
        entry.extraction_status,
        entry.needs_manual_review,
        '', // manual_claim_override - to be filled by reviewer
        ''  // manual_source_override - to be filled by reviewer
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    fs.writeFileSync(OUTPUT_REVIEW_CSV, csv);
}

// Run
main().catch(console.error);
