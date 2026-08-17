// Simple test to verify that the new core modules work correctly

import { runVerification, getReportUnits } from '../core/verify-run.js';
import { collectCitations } from '../core/citations.js';
import { proxyTransport, fetchSourceContent } from '../core/worker.js';
import { normalizeClaim, claimHash, sourceUrlHash } from '../core/anchor.js';

console.log('Testing core modules...');

// Test runVerification with empty citations
(async () => {
  try {
    const citations = [];
    const options = {
      fetchSource: () => Promise.resolve({ content: 'test', error: null, status: 200 }),
      verifySingle: () => Promise.resolve({ text: '{}', usage: { input: 0, output: 0 } }),
      verifyGroup: () => Promise.resolve({ text: '{}', usage: { input: 0, output: 0 } }),
      signal: null
    };

    const events = [];
    for await (const event of runVerification(citations, options)) {
      events.push(event);
    }

    console.log('✓ runVerification works with empty citations');
  } catch (error) {
    console.error('✗ runVerification failed:', error);
  }

  // Test getReportUnits
  try {
    const units = getReportUnits([], new Map());
    console.log('✓ getReportUnits works with empty results');
  } catch (error) {
    console.error('✗ getReportUnits failed:', error);
  }

  // Test collectCitations
  try {
    const citations = collectCitations(null);
    console.log('✓ collectCitations works with null root');
  } catch (error) {
    console.error('✗ collectCitations failed:', error);
  }

  // Test proxyTransport
  try {
    const transport = proxyTransport();
    console.log('✓ proxyTransport works');
  } catch (error) {
    console.error('✗ proxyTransport failed:', error);
  }

  // Test anchor functions
  try {
    const claim = 'Test claim text';
    const normalized = normalizeClaim(claim);
    const claimHashValue = claimHash(claim);
    const urlHashValue = sourceUrlHash('https://example.com');
    
    console.log('✓ anchor functions work');
  } catch (error) {
    console.error('✗ anchor functions failed:', error);
  }

  console.log('Core module tests completed.');
})();