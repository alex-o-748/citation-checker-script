// URL extraction helpers for Wikipedia reference elements.

export function extractHttpUrl(element) {
    if (!element) return null;
    // First look for archive links (prioritize these)
    const archiveLink = element.querySelector('a[href*="web.archive.org"], a[href*="archive.today"], a[href*="archive.is"], a[href*="archive.ph"], a[href*="webcitation.org"]');
    if (archiveLink) return archiveLink.href;

    // Fall back to any http link
    const links = element.querySelectorAll('a[href^="http"]');
    if (links.length === 0) return null;
    return links[0].href;
}

export function extractReferenceUrl(refElement) {
    const href = refElement.getAttribute('href');
    if (!href || !href.startsWith('#')) {
        console.log('[CitationVerifier] No valid href on refElement:', href);
        return null;
    }

    const refId = href.substring(1);
    const refTarget = document.getElementById(refId);

    if (!refTarget) {
        console.log('[CitationVerifier] No element found for refId:', refId);
        return null;
    }

    // Try to extract a direct HTTP URL from the footnote
    const directUrl = extractHttpUrl(refTarget);
    if (directUrl) return directUrl;

    // Harvard/sfn citation support: the footnote may contain only a
    // short-cite linking to the full citation via a #CITEREF anchor.
    // Follow that link to resolve the actual source URL.
    const citerefLink = refTarget.querySelector('a[href^="#CITEREF"]');
    if (citerefLink) {
        const citerefId = citerefLink.getAttribute('href').substring(1);
        const fullCitation = document.getElementById(citerefId);
        if (fullCitation) {
            const resolvedUrl = extractHttpUrl(fullCitation);
            if (resolvedUrl) {
                console.log('[CitationVerifier] Resolved Harvard/sfn citation via', citerefId);
                return resolvedUrl;
            }
        }
        // Also try the parent <li> or <cite> element in case the anchor
        // is on a child element within the full citation list item
        const fullCitationLi = fullCitation && fullCitation.closest('li');
        if (fullCitationLi && fullCitationLi !== fullCitation) {
            const resolvedUrl = extractHttpUrl(fullCitationLi);
            if (resolvedUrl) {
                console.log('[CitationVerifier] Resolved Harvard/sfn citation via parent li of', citerefId);
                return resolvedUrl;
            }
        }
        console.log('[CitationVerifier] Harvard/sfn citation found but no URL in full citation:', citerefId);
        return null;
    }

    console.log('[CitationVerifier] No http links in refTarget. innerHTML:', refTarget.innerHTML.substring(0, 500));
    return null;
}

export function extractPageNumber(refElement) {
    const href = refElement.getAttribute('href');
    if (!href || !href.startsWith('#')) return null;

    const refTarget = document.getElementById(href.substring(1));
    if (!refTarget) return null;

    const text = refTarget.textContent;
    // Match patterns like "p. 42", "pp. 42-43", "p.42", "page 42", "pages 42–43"
    const match = text.match(/\bp(?:p|ages?)?\.?\s*(\d+)/i);
    if (match) {
        console.log('[CitationVerifier] Extracted page number:', match[1]);
        return parseInt(match[1], 10);
    }
    return null;
}

export function isGoogleBooksUrl(url) {
    return /books\.google\./.test(url);
}
