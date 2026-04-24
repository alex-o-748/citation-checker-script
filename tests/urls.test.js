import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  extractHttpUrl,
  extractReferenceUrl,
  isGoogleBooksUrl,
} from '../core/urls.js';

test('extractHttpUrl pulls href from a direct <a>', () => {
  // The function calls querySelectorAll on the element, so it needs a container
  // with an <a> tag inside it, not the <a> tag itself
  const jsdom = new JSDOM(`<!DOCTYPE html><body><span id="container"><a href="https://example.com/page">link</a></span></body>`);
  const element = jsdom.window.document.getElementById('container');
  const url = extractHttpUrl(element);
  assert.equal(url, 'https://example.com/page');
});

test('isGoogleBooksUrl recognizes books.google.com URLs', () => {
  assert.equal(isGoogleBooksUrl('https://books.google.com/books?id=abc'), true);
  assert.equal(isGoogleBooksUrl('https://example.com/'), false);
});

test('extractReferenceUrl pulls the external link out of a citation element', () => {
  const jsdom = new JSDOM(`<!DOCTYPE html><body>
    <a id="ref-1" href="#cite_note-1">1</a>
    <span id="cite_note-1" class="reference">
      <cite class="citation"><a class="external" href="https://example.com/src">src</a></cite>
    </span>
  </body>`);

  const doc = jsdom.window.document;
  const refElement = doc.getElementById('ref-1');
  const url = extractReferenceUrl(refElement, doc);
  assert.equal(url, 'https://example.com/src');
});

test('extractReferenceUrl falls back to globalThis.document when no doc arg is passed', () => {
  const jsdom = new JSDOM(`<!DOCTYPE html><body>
    <a id="ref-1" href="#cite_note-1">1</a>
    <span id="cite_note-1" class="reference">
      <cite><a href="https://example.com/fallback">fallback</a></cite>
    </span>
  </body>`);

  const refElement = jsdom.window.document.getElementById('ref-1');
  const prev = globalThis.document;
  try {
    globalThis.document = jsdom.window.document;
    // Deliberately omit the second argument — simulates the browser path.
    const url = extractReferenceUrl(refElement);
    assert.equal(url, 'https://example.com/fallback');
  } finally {
    if (prev === undefined) delete globalThis.document; else globalThis.document = prev;
  }
});
