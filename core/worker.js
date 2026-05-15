// Calls to the Cloudflare Worker proxy: source fetching and verification logging.

import { isGoogleBooksUrl } from './urls.js';
import { augmentWithCitoid } from './citoid.js';

export async function fetchSourceContent(url, pageNum, { workerBase = 'https://publicai-proxy.alaexis.workers.dev', augment = true } = {}) {
    if (isGoogleBooksUrl(url)) {
        console.log('[CitationVerifier] Skipping Google Books URL:', url);
        return null;
    }

    try {
        let proxyUrl = `${workerBase}/?fetch=${encodeURIComponent(url)}`;
        if (pageNum) {
            proxyUrl += `&page=${pageNum}`;
        }
        const response = await fetch(proxyUrl);
        const data = await response.json();

        if (data.error) {
            console.warn('[CitationVerifier] Proxy error:', data.error);
            return null;
        }

        if (data.content && data.content.length > 100) {
            // Proxy caps fetched content around 12k chars. If we're at or
            // above that, the source was almost certainly truncated and
            // only partially sent to the model.
            const isTruncated = data.truncated === true || data.content.length >= 12000;
            let meta = `Source URL: ${url}`;
            if (data.pdf) {
                meta += `\nPDF: ${data.totalPages} pages`;
                if (data.page) {
                    meta += ` (extracted page ${data.page})`;
                }
            }
            if (isTruncated) {
                meta += `\nTruncated: true`;
            }
            const body = augment ? await augmentWithCitoid(data.content, url) : data.content;
            return `${meta}\n\nSource Content:\n${body}`;
        }

        // If PDF was large and we didn't request a specific page, retry
        // with the citation page if available
        if (data.pdf && !pageNum && data.totalPages > 15) {
            console.log('[CitationVerifier] Large PDF without page param, content may be truncated');
        }
    } catch (error) {
        console.error('Proxy fetch failed:', error);
    }
    return null; // Falls back to manual input
}

export function logVerification(payload, { workerBase = 'https://publicai-proxy.alaexis.workers.dev' } = {}) {
    // Wrap the fetch POST in try/catch exactly as main.js does.
    // `payload` replaces the constructed object in main.js — caller supplies
    //   { article_url, article_title, citation_number, source_url, provider, verdict, confidence }.
    try {
        fetch(`${workerBase}/log`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }).catch(() => {});
    } catch (e) {
        // logging should never break the main flow
    }
}
