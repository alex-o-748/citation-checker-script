// Calls to the Cloudflare Worker proxy: source fetching and verification logging.

import { isGoogleBooksUrl, parseArchiveOrgUrl } from './urls.js';

/**
 * Default proxy transport implementation using the Cloudflare Worker
 */
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

/**
 * Proxy transport implementation - extracted from the original fetchSourceContent
 * to enable injection of different transports
 */
export function proxyTransport({ workerBase = 'https://publicai-proxy.alaexis.workers.dev' } = {}) {
    return async function fetchSource(url, pageNum) {
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
    };
}

/**
 * Core source fetching function that uses a transport
 * Always returns { content, error, status }
 */
export async function fetchSourceContent(url, pageNum, { 
    transport = proxyTransport(), 
    workerBase = 'https://publicai-proxy.alaexis.workers.dev' 
} = {}) {
    // If transport is the older function signature, wrap it
    if (typeof transport === 'function' && transport.length <= 2) {
        return transport(url, pageNum);
    }
    
    // If transport is an object with fetchSource method
    if (transport && typeof transport.fetchSource === 'function') {
        return transport.fetchSource(url, pageNum);
    }
    
    // Default to proxy transport
    const proxyFetch = proxyTransport({ workerBase });
    return proxyFetch(url, pageNum);
}

// Helper function to assemble group sources
export function assembleGroupSources(entries) {
    const parts = [];
    let anyAvailable = false;
    
    for (const e of entries) {
        if (e.content) {
            const text = extractSourceText(e.content);
            if (text && text.trim()) {
                anyAvailable = true;
                const nums = e.citationNumbers.join(', ');
                parts.push(`== Source [${nums}] ==\n${text}`);
            }
        }
    }
    
    return {
        text: parts.join('\n\n'),
        anyAvailable
    };
}

// Helper function to extract source text
export function extractSourceText(content) {
    if (!content) return '';
    
    const marker = '\n\nSource Content:\n';
    const index = content.indexOf(marker);
    return index !== -1 ? content.slice(index + marker.length) : content;
}

export function logVerification(payload, { workerBase = 'https://publicai-proxy.alaexis.workers.dev' } = {}) {
    // Caller supplies the payload object; build it with buildLogPayload()
    // from core/feedback.js so the keys line up with the Neon columns.
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

// Ratings and talk-page pointers. Unlike logVerification this resolves, so the
// UI can tell the user whether their rating actually landed — a silent no-op
// on a button the user deliberately pressed would be worse than an error.
export function postFeedback(payload, { workerBase = 'https://publicai-proxy.alaexis.workers.dev' } = {}) {
    return fetch(`${workerBase}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    }).then(res => {
        if (!res.ok) throw new Error(`Feedback failed: HTTP ${res.status}`);
        return true;
    });
}