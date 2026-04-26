// Extracts the prose claim text bearing a given citation from a parsed
// Wikipedia Document. Works with both browser DOM and JSDOM.

export const MAINTENANCE_MARKER_RE = /\[(failed verification|verification needed|citation needed|better source[^\]]*|dubious[^\]]*|unreliable source[^\]]*|clarification needed|disputed[^\]]*|page needed|when\??|where\??|who\??|why\??|by whom\??|according to whom\??|original research[^\]]*|specify[^\]]*|vague|opinion|fact)\]/gi;

export function extractClaimText(refElement) {
    const document = refElement.ownerDocument;
    const container = refElement.closest('p, li, td, div, section');
    if (!container) {
        return '';
    }

    // Get the current reference wrapper element
    const currentRef = refElement.closest('.reference');
    if (!currentRef) {
        // Fallback: return container text
        return container.textContent
            .replace(/\[\d+\]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Find all references in the same container
    const refsInContainer = Array.from(container.querySelectorAll('.reference'));
    const currentIndexInContainer = refsInContainer.indexOf(currentRef);

    let claimStartNode = null;

    if (currentIndexInContainer > 0) {
        // There are previous references in this container
        // Walk backwards to find where the claim actually starts

        for (let i = currentIndexInContainer - 1; i >= 0; i--) {
            const prevRef = refsInContainer[i];

            // Check if there's actual text between this ref and the next one
            const range = document.createRange();
            range.setStartAfter(prevRef);

            if (i === currentIndexInContainer - 1) {
                range.setEndBefore(currentRef);
            } else {
                range.setEndBefore(refsInContainer[i + 1]);
            }

            const textBetween = range.toString().replace(/\s+/g, '').trim();

            if (textBetween.length > 0) {
                // Found text before this point - the previous ref is our boundary
                claimStartNode = prevRef;
                break;
            }
            // No text between these refs - they cite the same claim, keep looking back
        }
    }

    // Extract the text from the boundary to the current reference
    const extractionRange = document.createRange();

    if (claimStartNode) {
        extractionRange.setStartAfter(claimStartNode);
    } else {
        // No previous ref boundary - start from beginning of container
        extractionRange.setStart(container, 0);
    }
    extractionRange.setEndBefore(currentRef);

    // Get the text content
    let claimText = extractionRange.toString();

    // Clean up the text. Whitespace normalization must run BEFORE the
    // maintenance-marker strip: Wikipedia's {{failed verification}} and similar
    // templates use white-space:nowrap and emit U+00A0 (NBSP) between the
    // words, which the literal-space alternatives in MAINTENANCE_MARKER_RE
    // would otherwise fail to match.
    claimText = claimText
        .replace(/\[\d+\]/g, '')                 // Remove reference numbers like [1], [2]
        .replace(/\s+/g, ' ')                    // Normalize whitespace (incl. NBSP)
        .replace(MAINTENANCE_MARKER_RE, '')      // Remove maintenance markers like [failed verification]
        .trim();

    // If we got nothing meaningful, fall back to the container text
    if (!claimText || claimText.length < 10) {
        claimText = container.textContent
            .replace(/\[\d+\]/g, '')
            .replace(/\s+/g, ' ')
            .replace(MAINTENANCE_MARKER_RE, '')
            .trim();
    }

    return claimText;
}
