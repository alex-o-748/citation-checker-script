// Parses raw LLM response text into a structured verdict object.
//
// Happy path: JSON, optionally inside a ```json code fence or surrounded by
// prose. Falls back to a markdown-emphasis recovery regex for small
// open-weight models (e.g. Granite 4.1 8B) that occasionally emit
// "**Verdict:** SUPPORTED" prose instead of the requested JSON. On total
// failure, returns the 'PARSE_ERROR' sentinel — chosen to match what the
// benchmark already records for unrecoverable responses.

import { canonicalizeVerdict } from './verdicts.js';

export function parseVerificationResult(response) {
    const trimmed = response.trim();

    try {
        let jsonStr = trimmed;
        const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (codeBlockMatch) {
            jsonStr = codeBlockMatch[1].trim();
        } else {
            const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
            if (jsonMatch) jsonStr = jsonMatch[0];
        }
        const result = JSON.parse(jsonStr);
        return {
            verdict: result.verdict || 'UNKNOWN',
            confidence: result.confidence ?? null,
            comments: result.comments || ''
        };
    } catch (e) {
        // fall through to the markdown-emphasis recovery
    }

    // Strip "**" and "__"-style emphasis so e.g. "**Verdict:** SUPPORTED"
    // becomes "Verdict: SUPPORTED", then capture the canonical word(s).
    const stripped = trimmed.replace(/\*+|__+/g, '');
    const match = stripped.match(/verdict[\s:"']+([A-Z][A-Z _]*)/i);
    if (match) {
        const verdict = canonicalizeVerdict(match[1]);
        if (verdict) {
            return { verdict, confidence: null, comments: '<extracted from non-JSON response>' };
        }
    }

    return {
        verdict: 'PARSE_ERROR',
        confidence: null,
        comments: `Failed to parse AI response: ${response.substring(0, 200)}`
    };
}
