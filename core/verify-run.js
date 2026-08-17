// Core verification orchestration logic. Extracted from main.js's verifyAllCitations()
// to enable reuse in CLI, batch jobs, and tests.

import { withRetry } from './retry.js';
import { assembleGroupSources, extractSourceText } from './worker.js';

/**
 * Run verification on a collection of citations, yielding events as results arrive.
 * 
 * @param {Array} citations - Array of citation objects with claimText, url, etc.
 * @param {Object} options - Configuration options
 * @param {Function} options.fetchSource - Function to fetch source content (url, pageNum) => Promise<{ content, error, status }>
 * @param {Function} options.verifySingle - Function to verify a single claim (claim, sourceInfo) => Promise<{ text, usage }>
 * @param {Function} options.verifyGroup - Function to verify a group of claims (claim, assembledText) => Promise<{ text, usage }>
 * @param {Map} options.cache - Optional cache for source content
 * @param {number} options.delayBetweenCalls - Delay between API calls in ms
 * @param {AbortSignal} options.signal - AbortSignal for cancellation
 * @param {Object} options.retry - Retry configuration
 * @param {Function} options.sleep - Sleep function for delays
 */
export async function* runVerification(citations, {
  fetchSource,     // (url, pageNum) => Promise<{ content, error, status }>
  verifySingle,    // (claim, sourceInfo)   => Promise<{ text, usage }>
  verifyGroup,     // (claim, assembledText) => Promise<{ text, usage }>
  cache = new Map(),          // injectable so batch can share across articles
  delayBetweenCalls = 1000,
  signal,                     // AbortSignal
  retry = { maxRetries: 4, minBackoffMs: 5000, maxBackoffMs: 30000, jitterMs: 0 },
  sleep = ms => new Promise(r => setTimeout(r, ms)),  // injectable: tests run instantly
}) {
  if (citations.length === 0) {
    yield { type: 'done', completed: 0, total: 0, aborted: false };
    return;
  }

  // Estimate time and prepare for processing
  const uniqueUrls = new Set(citations.filter(c => c.url).map(c => c.url));
  const multiGroupIds = new Set(citations.filter(c => c.groupSize > 1).map(c => c.groupId));
  const multiGroupCount = multiGroupIds.size;
  
  // Progress counts every LLM step: one per citation, plus one
  // collective check per adjacent group.
  const progressTotal = citations.length + multiGroupCount;
  let completed = 0;

  for (let i = 0; i < citations.length; i++) {
    // Check for cancellation
    if (signal && signal.aborted) {
      yield { type: 'done', completed, total: progressTotal, aborted: true };
      return;
    }

    const citation = citations[i];
    
    // Yield progress event
    yield { 
      type: 'progress', 
      phase: 'verifying', 
      citationNumber: citation.citationNumber, 
      completed, 
      total: progressTotal 
    };

    let result;

    if (!citation.url) {
      // No URL found
      result = {
        citationNumber: citation.citationNumber,
        claimText: citation.claimText,
        url: null,
        refElement: citation.refElement,
        verdict: 'SOURCE UNAVAILABLE',
        confidence: 0,
        unavailableReason: 'no_url',
        comments: '', // Will be localized by the consumer
        truncated: false
      };
    } else {
      // Fetch source if not cached. Cache value is always the
      // full { content, error, status } shape so retries on the
      // same URL preserve the diagnostic for the submission link.
      const cacheKey = citation.pageNum ? `${citation.url}|page=${citation.pageNum}` : citation.url;

      if (!cache.has(cacheKey)) {
        // Yield progress event for fetching
        yield { 
          type: 'progress', 
          phase: 'fetching', 
          citationNumber: citation.citationNumber, 
          completed, 
          total: progressTotal 
        };
        
        try {
          const fetchResult = await fetchSource(citation.url, citation.pageNum);
          cache.set(cacheKey, fetchResult);
        } catch (e) {
          cache.set(cacheKey, { content: null, error: e?.message || 'fetch threw', status: null });
        }
        
        // Rate limit delay after fetch
        if (signal && !signal.aborted) {
          await sleep(delayBetweenCalls);
        }
      }

      if (signal && signal.aborted) {
        yield { type: 'done', completed, total: progressTotal, aborted: true };
        return;
      }

      const fetchResult = cache.get(cacheKey) || { content: null, error: null, status: null };
      const sourceContent = fetchResult.content;

      if (!sourceContent) {
        const statusPart = fetchResult.status != null ? `HTTP ${fetchResult.status}` : null;
        const reasonPart = fetchResult.error || ''; // Will be localized by the consumer
        const comments = statusPart ? `${statusPart}: ${reasonPart}` : reasonPart;
        result = {
          citationNumber: citation.citationNumber,
          claimText: citation.claimText,
          url: citation.url,
          refElement: citation.refElement,
          verdict: 'SOURCE UNAVAILABLE',
          confidence: 0,
          unavailableReason: 'fetch_failed',
          comments,
          fetchStatus: fetchResult.status,
          fetchError: fetchResult.error,
          truncated: false
        };
      } else {
        const sourceTruncated = sourceContent.includes('\nTruncated: true');
        // Verify via LLM. Retry transient failures (429 + 5xx +
        // network) through the shared core/retry.js helper
        yield { 
          type: 'progress', 
          phase: 'verifying', 
          citationNumber: citation.citationNumber, 
          completed, 
          total: progressTotal 
        };
        
        try {
          const apiResult = await withRetry(
            () => verifySingle(citation.claimText, sourceContent),
            {
              ...retry,
              shouldAbort: () => signal && signal.aborted
            }
          );
          
          result = {
            citationNumber: citation.citationNumber,
            claimText: citation.claimText,
            url: citation.url,
            refElement: citation.refElement,
            verdict: 'UNKNOWN', // Will be parsed from apiResult.text
            confidence: null,   // Will be parsed from apiResult.text
            comments: '',       // Will be parsed from apiResult.text
            reason_type: null,  // Will be parsed from apiResult.text
            truncated: sourceTruncated,
            usage: apiResult.usage
          };

        } catch (e) {
          result = {
            citationNumber: citation.citationNumber,
            claimText: citation.claimText,
            url: citation.url,
            refElement: citation.refElement,
            verdict: 'ERROR',
            confidence: null,
            comments: e.message,
            truncated: sourceTruncated
          };
        }

        // Rate limit delay after LLM call
        if (signal && !signal.aborted && i < citations.length - 1) {
          await sleep(delayBetweenCalls);
        }
      }
    }

    if (result) {
      // Carry the group metadata from the citation onto the
      // result so the renderer and the wikitext exporter can
      // cluster sibling citations without re-deriving groups.
      result.groupId = citation.groupId;
      result.groupSize = citation.groupSize;
      result.groupIndex = citation.groupIndex;
      result.groupCitationNumbers = citation.groupCitationNumbers;
      
      yield { type: 'result', result };
    }

    completed++;

    // When this citation closes an adjacent-citation group, run the
    // collective check: the whole group's sources are cached by now
    // (group members are contiguous and processed in order), so we
    // assemble them and ask for a single verdict over the combination.
    if (citation.groupSize > 1 && citation.groupIndex === citation.groupSize - 1 && !(signal && signal.aborted)) {
      yield { 
        type: 'progress', 
        phase: 'group', 
        citationNumber: citation.citationNumber, 
        completed, 
        total: progressTotal 
      };
      
      // Process group verification
      const groupResult = await processGroupVerification(
        citation, citations, cache, verifyGroup, retry, signal
      );
      
      if (groupResult) {
        yield groupResult;
      }
      
      completed++;
    }
  }

  // Finalize
  yield { type: 'done', completed, total: progressTotal, aborted: signal && signal.aborted };
}

/**
 * Process group verification for adjacent citation groups
 */
async function processGroupVerification(triggerCitation, citations, cache, verifyGroup, retry, signal) {
  const groupId = triggerCitation.groupId;
  const members = citations
    .filter(c => c.groupId === groupId)
    .sort((a, b) => (a.groupIndex ?? 0) - (b.groupIndex ?? 0));
  if (members.length === 0) return null;

  const claimText = members[0].claimText;
  const groupCitationNumbers = triggerCitation.groupCitationNumbers || members.map(m => m.citationNumber);

  // Dedupe by cache key so a source cited twice in the group (named
  // refs) is sent once, with both citation numbers on its label.
  const byKey = new Map();
  for (const m of members) {
    const cacheKey = m.url
      ? (m.pageNum ? `${m.url}|page=${m.pageNum}` : m.url)
      : `__nourl_${m.citationNumber}`;
    let entry = byKey.get(cacheKey);
    if (!entry) {
      const fetchResult = m.url
        ? (cache.get(cacheKey) || { content: null, error: null, status: null })
        : { content: null, error: 'No URL found in reference', status: null };
      entry = {
        citationNumbers: [],
        url: m.url || null,
        content: fetchResult.content,
        error: fetchResult.error,
        status: fetchResult.status,
      };
      byKey.set(cacheKey, entry);
    }
    entry.citationNumbers.push(m.citationNumber);
  }
  const entries = Array.from(byKey.values());
  const truncated = entries.some(e => e.content && e.content.includes('\nTruncated: true'));
  const { text: assembledText, anyAvailable } = assembleGroupSources(entries);

  // When only one source is available the collective verdict would
  // duplicate the individual per-source result, so skip it.
  const availableCount = entries.filter(e => e.content && extractSourceText(e.content).trim()).length;
  if (availableCount <= 1) {
    return { type: 'group-skipped', groupId };
  }

  const base = {
    groupId,
    isGroup: true,
    groupSize: members.length,
    groupCitationNumbers,
    citationNumber: groupCitationNumbers.join(', '),
    claimText,
    refElement: members[0].refElement,
    members: members.map(m => ({ citationNumber: m.citationNumber, url: m.url || null, refElement: m.refElement })),
    memberUrls: entries.map(e => e.url).filter(Boolean),
    url: (entries.find(e => e.url) || {}).url || null,
    truncated,
  };

  let result;
  if (!anyAvailable) {
    result = { ...base, verdict: 'SOURCE UNAVAILABLE', confidence: 0, unavailableReason: 'none_available', comments: '' };
    return { type: 'group-result', result };
  } else {
    try {
      const apiResult = await withRetry(
        () => verifyGroup(claimText, assembledText),
        {
          ...retry,
          shouldAbort: () => signal && signal.aborted,
        }
      );
      
      result = {
        ...base,
        verdict: 'UNKNOWN', // Will be parsed from apiResult.text
        confidence: null,   // Will be parsed from apiResult.text
        comments: '',       // Will be parsed from apiResult.text
        reason_type: null,  // Will be parsed from apiResult.text
        usage: apiResult.usage
      };
      return { type: 'group-result', result };
    } catch (e) {
      result = { ...base, verdict: 'ERROR', confidence: null, comments: e.message };
      return { type: 'group-result', result };
    }
  }
}

/**
 * Helper function to create verifiers with specific provider configurations
 */
export function makeVerifiers({ provider, apiKey, model, systemPromptTransform }) {
  // This function would create and return verifySingle and verifyGroup functions
  // based on the provider configuration. Implementation would depend on the
  // existing provider logic in main.js and core/providers.js
  
  // Placeholder implementation - would need to be filled in based on existing code
  return {
    verifySingle: async (claim, sourceInfo) => {
      throw new Error('Not implemented: verifySingle needs to be implemented based on existing provider logic');
    },
    verifyGroup: async (claim, assembledText) => {
      throw new Error('Not implemented: verifyGroup needs to be implemented based on existing provider logic');
    }
  };
}

/**
 * Merges per-source results and collective group verdicts into one
 * entry per claim (document order): solo citations pass through; an
 * adjacent group collapses to its collective verdict. Groups whose
 * collective check hasn't completed yet are omitted until it does.
 * Used by the summary counts and the wikitext/plaintext exporters.
 */
export function getReportUnits(reportResults, reportGroupResults) {
  const units = [];
  const seenGroups = new Set();
  for (const r of reportResults) {
    if (r.groupSize && r.groupSize > 1) {
      if (seenGroups.has(r.groupId)) continue;
      seenGroups.add(r.groupId);
      const collective = reportGroupResults.get(r.groupId);
      if (collective && !collective.skipped) {
        units.push(collective);
      } else if (collective && collective.skipped) {
        for (const x of reportResults) {
          if (x.groupId === r.groupId) units.push(x);
        }
      }
    } else {
      units.push(r);
    }
  }
  return units;
}