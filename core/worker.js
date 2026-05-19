// Calls to the Cloudflare Worker proxy: source fetching and verification logging.

import { isGoogleBooksUrl } from './urls.js';

// Always returns { content, error, status }. `content` is the formatted source
// text on success and null on any failure; `error` is a short human-readable
// reason when content is null; `status` is the upstream HTTP status code if the
// proxy reports one (`data.status`), otherwise the proxy's own response status,
// or null if we never got a response at all.
export async function fetchSourceContent(url, pageNum, { workerBase = 'https://publicai-proxy.alaexis.workers.dev' } = {}) {
    if (isGoogleBooksUrl(url)) {
        console.log('[CitationVerifier] Skipping Google Books URL:', url);
        return { content: null, error: 'Google Books URL skipped (no fetchable content)', status: null };
    }

    try {
        let proxyUrl = `${workerBase}/?fetch=${encodeURIComponent(url)}`;
        if (pageNum) {
            proxyUrl += `&page=${pageNum}`;
        }
        const response = await fetch(proxyUrl);
        const proxyStatus = response.status;
        let data = null;
        try {
            data = await response.json();
        } catch (_) {
            return { content: null, error: `Proxy returned non-JSON response (HTTP ${proxyStatus})`, status: proxyStatus };
        }

        const status = (data && typeof data.status === 'number') ? data.status : proxyStatus;

        if (data.error) {
            console.warn('[CitationVerifier] Proxy error:', data.error);
            return { content: null, error: data.error, status };
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
            return { content: `${meta}\n\nSource Content:\n${data.content}`, error: null, status };
        }

        // If PDF was large and we didn't request a specific page, retry
        // with the citation page if available
        if (data.pdf && !pageNum && data.totalPages > 15) {
            console.log('[CitationVerifier] Large PDF without page param, content may be truncated');
        }
        return { content: null, error: 'Source content was empty or too short to verify', status };
    } catch (error) {
        console.error('Proxy fetch failed:', error);
        return { content: null, error: error?.message || String(error), status: null };
    }
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
