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
  // Set up a document where we create a reference that points to a footnote with a link
  // The function uses document.getElementById() globally, so we need to set that up correctly
  const jsdom = new JSDOM(`<!DOCTYPE html><body>
    <a id="ref-1" href="#cite_note-1">1</a>
    <span id="cite_note-1" class="reference">
      <cite class="citation"><a class="external" href="https://example.com/src">src</a></cite>
    </span>
  </body>`);

  const refElement = jsdom.window.document.getElementById('ref-1');
  // Inject document into global scope for the function to use
  global.document = jsdom.window.document;

  const url = extractReferenceUrl(refElement);

  // Clean up
  delete global.document;

  assert.equal(url, 'https://example.com/src');
});
