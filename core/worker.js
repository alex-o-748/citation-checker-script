// Calls to the Cloudflare Worker proxy: source fetching and verification logging.

import { isGoogleBooksUrl, parseArchiveOrgUrl } from './urls.js';

async function fetchViaProxy(fetchUrl, pageNum, workerBase, sourceUrl) {
    try {
        let proxyUrl = `${workerBase}/?fetch=${encodeURIComponent(fetchUrl)}`;
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
            const isTruncated = data.truncated === true || data.content.length >= 12000;
            let meta = `Source URL: ${sourceUrl}`;
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

        if (data.pdf && !pageNum && data.totalPages > 15) {
            console.log('[CitationVerifier] Large PDF without page param, content may be truncated');
        }
        return { content: null, error: 'Source content was empty or too short to verify', status };
    } catch (error) {
        console.error('Proxy fetch failed:', error);
        return { content: null, error: error?.message || String(error), status: null };
    }
}

async function findWaybackSnapshot(url) {
    try {
        const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
        const response = await fetch(apiUrl);
        const data = await response.json();
        const snapshot = data?.archived_snapshots?.closest;
        if (snapshot?.available && snapshot.timestamp) {
            return `https://web.archive.org/web/${snapshot.timestamp}id_/${url}`;
        }
    } catch (e) {
        console.warn('[CitationVerifier] Wayback availability check failed:', e?.message);
    }
    return null;
}

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

    const archiveInfo = parseArchiveOrgUrl(url);
    if (archiveInfo) {
        const rawUrl = `https://web.archive.org/web/${archiveInfo.timestamp}id_/${archiveInfo.originalUrl}`;
        console.log('[CitationVerifier] Fetching via Wayback raw endpoint');
        return fetchViaProxy(rawUrl, pageNum, workerBase, url);
    }

    const result = await fetchViaProxy(url, pageNum, workerBase, url);

    if (!result.content) {
        const waybackUrl = await findWaybackSnapshot(url);
        if (waybackUrl) {
            console.log('[CitationVerifier] Live fetch failed, trying Wayback snapshot');
            return fetchViaProxy(waybackUrl, pageNum, workerBase, url);
        }
    }

    return result;
}

export function logVerification(payload, { workerBase = 'https://publicai-proxy.alaexis.workers.dev' } = {}) {
    // Caller supplies the payload object:
    //   { article_url, article_title, citation_number, source_url, provider,
    //     verdict, confidence, reason_type }.
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
