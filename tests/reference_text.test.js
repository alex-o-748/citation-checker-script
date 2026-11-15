// The citation details sent with every check: the footnote's text
// (core/urls.js's extractReferenceText(), carried as core/citations.js's
// referenceText), the source URL and today's date, and how the prompts carry
// them. See docs/design-plans/2026-11-08-fixable-causes-of-disputed-verdicts.md §1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { extractReferenceText, REFERENCE_TEXT_MAX_CHARS } from '../core/urls.js';
import { collectCitations } from '../core/citations.js';
import {
  generateSystemPrompt, generateGroupSystemPrompt, generateUserPrompt,
  generateGroupUserPrompt, assembleGroupSources, todayIsoDate,
} from '../core/prompts.js';
import { groupSourceEntries } from '../core/groups.js';
import { verifyCitation } from '../core/pipeline.js';
import { verifyCitation as verifyBatchCitation, verifyGroup } from '../service/verifier.js';

// A footnote as Parsoid renders it (enwiki's read view, and the REST HTML the
// batch parses): backlinks, then the reference text.
function footnoteDoc(footnotes, { fragment = false } = {}) {
  const markers = Object.keys(footnotes)
    .map(id => `Some claim text here.<sup class="reference" id="cite_ref-${id}"><a href="./Article#cite_note-${id}">[${id}]</a></sup>`)
    .join(' ');
  const list = Object.entries(footnotes).map(([id, html]) => html.startsWith('<li')
    ? html
    : `<li id="cite_note-${id}"><span class="mw-cite-backlink"><a href="#cite_ref-${id}"><span class="mw-linkback-text">↑</span></a></span> <span class="mw-reference-text reference-text">${html}</span></li>`).join('');
  const html = `<p>${markers}</p><ol class="references">${list}</ol>`;
  return fragment ? JSDOM.fragment(html) : new JSDOM(`<!DOCTYPE html><body>${html}</body>`).window.document;
}

const refFor = (doc, id) => doc.querySelector(`#cite_ref-${id} a`);

// enwiki, Immigration to the United States (oldid 1331476438), footnote 4:
// TemplateStyles CSS, a three-way backlink, "Archived from the original",
// CS1's access date and a COinS span — all of it chrome.
const CS1_ARCHIVED = `<style data-mw-deduplicate="TemplateStyles:r1">.mw-parser-output cite.citation{font-style:inherit}</style>`
  + `<cite class="citation web cs1"><a class="external text" href="https://www.dhs.gov/table7">"Table 7. Persons Obtaining Lawful Permanent Resident Status"</a>. <i>DHS.gov</i>. `
  + `<a href="https://en.wikipedia.org/wiki/DHS">United States Department of Homeland Security</a> (DHS). December 18, 2017. `
  + `<a class="external text" href="https://web.archive.org/web/20200403052733/https://www.dhs.gov/table7">Archived</a> from the original on April 3, 2020`
  + `<span class="reference-accessdate">. Retrieved <span class="nowrap">June 23,</span> 2018</span>.</cite>`
  + `<span title="ctx_ver=Z39.88-2004" class="Z3988"></span>`;

test('extractReferenceText reads a CS1 citation without styles, archive boilerplate or access date', () => {
  const doc = footnoteDoc({ 4: CS1_ARCHIVED });
  assert.equal(
    extractReferenceText(refFor(doc, 4), doc),
    '"Table 7. Persons Obtaining Lawful Permanent Resident Status". DHS.gov. United States Department of Homeland Security (DHS). December 18, 2017.'
  );
});

test('extractReferenceText keeps the punctuation between authors', () => {
  // The cleanup that collapses ". ." left behind by a removed phrase must not
  // eat the "; " separating two authors after an initial.
  const doc = footnoteDoc({ 1: '<cite class="citation web cs1">Camarota, Steven A.; Zeigler, Karen (March 12, 2025). "Foreign-Born Number". <i>CIS.org</i><span class="reference-accessdate">. Retrieved <span class="nowrap">May 16,</span> 2025</span>.</cite>' });
  assert.equal(extractReferenceText(refFor(doc, 1), doc), 'Camarota, Steven A.; Zeigler, Karen (March 12, 2025). "Foreign-Born Number". CIS.org.');
});

test('extractReferenceText drops dewiki\'s Abrufdatum and hidden COinS (the Protekta [4] case)', () => {
  const doc = footnoteDoc({ 4: '<span class="cite"><a class="external text" href="https://www.handelszeitung.ch/insurance/protekta"><i>Protekta ist neue Marktleaderin im Rechtsschutzmarkt.</i></a><span> </span>In:<span> </span><i>Handelszeitung.</i><span> </span>25.<span>&nbsp;</span>Mai 2021<span>,</span><span class="Abrufdatum"><span> </span>abgerufen am 20.<span>&nbsp;</span>Oktober 2026</span>.</span><span style="display: none;" class="Z3988" title="x"><span>&nbsp;</span></span>' });
  assert.equal(extractReferenceText(refFor(doc, 4), doc), 'Protekta ist neue Marktleaderin im Rechtsschutzmarkt. In: Handelszeitung. 25. Mai 2021.');
});

test('extractReferenceText drops ruwiki\'s archive copy and access date', () => {
  const doc = footnoteDoc({ 3: '<a class="external text" href="http://constitution.garant.ru/x">Закон Российской Федерации от 9 декабря 1992 года № 4061-I</a> <a class="external text" href="https://web.archive.org/web/20140226001506/http://constitution.garant.ru/x">Архивная копия</a> от 26 февраля 2014 на <a href="https://ru.wikipedia.org/wiki/Wayback_Machine">Wayback Machine</a>. Гарант. Дата обращения: 5 мая 2021.' });
  assert.equal(extractReferenceText(refFor(doc, 3), doc), 'Закон Российской Федерации от 9 декабря 1992 года № 4061-I. Гарант.');
});

test('extractReferenceText drops {{webarchive}}\'s "Archived … at the Wayback Machine"', () => {
  const doc = footnoteDoc({ 2: '"Annual report". Acme Corp. 2019. Archived 2020-03-12 at the <a href="https://en.wikipedia.org/wiki/Wayback_Machine">Wayback Machine</a>.' });
  assert.equal(extractReferenceText(refFor(doc, 2), doc), '"Annual report". Acme Corp. 2019.');
});

test('extractReferenceText appends the full citation a Harvard/sfn short cite points at', () => {
  const doc = footnoteDoc({ 7: '<a href="#CITEREFMiller2018">Miller 2018</a>, p. 627.' });
  const bib = doc.createElement('div');
  bib.innerHTML = '<cite id="CITEREFMiller2018" class="citation book cs1">Miller, Jane (2018). <i>A History of Bridges</i>. Oxford University Press.</cite>';
  doc.body.appendChild(bib);
  assert.equal(
    extractReferenceText(refFor(doc, 7), doc),
    'Miller 2018, p. 627. Miller, Jane (2018). A History of Bridges. Oxford University Press.'
  );
});

test('extractReferenceText puts a sub-reference\'s main citation in front of its details', () => {
  const doc = footnoteDoc({
    main: `<li id="cite_note-Miller-10"><span class="mw-cite-backlink">↑</span> <span class="reference-text">Miller: <i>Book</i>. 2018.</span>`
      + `<ol class="mw-subreference-list"><li id="cite_note-11"><span class="mw-cite-backlink"><a href="#cite_ref-11">↑</a></span> <span class="reference-text">p. 627.</span></li></ol></li>`,
  });
  const marker = doc.createElement('sup');
  marker.className = 'reference';
  marker.innerHTML = '<a href="#cite_note-11">[10.1]</a>';
  doc.body.prepend(marker);
  assert.equal(extractReferenceText(marker.querySelector('a'), doc), 'Miller: Book. 2018. p. 627.');
  // And the main reference's own text leaves its sub-references out.
  const mainMarker = doc.createElement('sup');
  mainMarker.className = 'reference';
  mainMarker.innerHTML = '<a href="#cite_note-Miller-10">[10]</a>';
  doc.body.prepend(mainMarker);
  assert.equal(extractReferenceText(mainMarker.querySelector('a'), doc), 'Miller: Book. 2018.');
});

test('extractReferenceText caps a long footnote at a word boundary', () => {
  const doc = footnoteDoc({ 9: `"Title". The Times. 2020. ${'A long editorial note about the source. '.repeat(40)}` });
  const text = extractReferenceText(refFor(doc, 9), doc);
  assert.ok(text.length <= REFERENCE_TEXT_MAX_CHARS + 2, `too long: ${text.length}`);
  assert.ok(text.startsWith('"Title". The Times. 2020.'));
  assert.ok(text.endsWith(' …'));
});

test('extractReferenceText is null when the footnote is missing or empty', () => {
  const doc = footnoteDoc({ 1: '<style>.x{}</style>' });
  assert.equal(extractReferenceText(refFor(doc, 1), doc), null);
  const orphan = doc.createElement('a');
  orphan.setAttribute('href', '#cite_note-nowhere');
  assert.equal(extractReferenceText(orphan, doc), null);
  const noHref = doc.createElement('a');
  assert.equal(extractReferenceText(noHref, doc), null);
});

test('collectCitations carries referenceText, on a JSDOM.fragment() root too', () => {
  for (const fragment of [false, true]) {
    const doc = footnoteDoc({ 4: CS1_ARCHIVED }, { fragment });
    const [citation] = collectCitations(doc);
    assert.match(citation.referenceText, /^"Table 7\..*December 18, 2017\.$/, `fragment=${fragment}`);
  }
});

// --- prompts ---

test('generateUserPrompt puts the citation, URL and date between the claim and the source text', () => {
  const out = generateUserPrompt('Protekta was named market leader in the Handelszeitung.', 'Source URL: https://x\n\nSource Content:\nBODY', {
    citation: '  Protekta ist neue Marktleaderin.\n In: Handelszeitung. 25. Mai 2021.',
    sourceUrl: 'https://www.handelszeitung.ch/insurance/protekta',
    today: '2026-11-15',
  });
  assert.equal(out, [
    'Claim: "Protekta was named market leader in the Handelszeitung."',
    '',
    'Citation (as given in the article): Protekta ist neue Marktleaderin. In: Handelszeitung. 25. Mai 2021.',
    'Source URL: https://www.handelszeitung.ch/insurance/protekta',
    "Today's date: 2026-11-15",
    '',
    'Source text:',
    'BODY',
  ].join('\n'));
});

test('generateUserPrompt without details is the prompt it always was', () => {
  const expected = 'Claim: "C"\n\nSource text:\nBODY';
  assert.equal(generateUserPrompt('C', 'BODY'), expected);
  assert.equal(generateUserPrompt('C', 'BODY', {}), expected);
  assert.equal(generateUserPrompt('C', 'BODY', null), expected);
  assert.equal(generateUserPrompt('C', 'BODY', { citation: '   ', sourceUrl: null, today: undefined }), expected);
});

test('generateUserPrompt leaves out each missing detail on its own', () => {
  const out = generateUserPrompt('C', 'BODY', { today: '2026-01-02' });
  assert.equal(out, 'Claim: "C"\n\nToday\'s date: 2026-01-02\n\nSource text:\nBODY');
});

test('both system prompts say what citation details are evidence for, and what not', () => {
  for (const prompt of [generateSystemPrompt(), generateGroupSystemPrompt()]) {
    assert.match(prompt, /citation as it appears in the Wikipedia article/);
    assert.match(prompt, /who wrote it, and when it was published, and for nothing else in the claim/);
    assert.match(prompt, /resolve relative dates/);
    assert.match(prompt, /today's date are in the past/);
  }
});

test('assembleGroupSources puts each source\'s citation under its URL, unavailable ones too', () => {
  const { text } = assembleGroupSources([
    { url: 'https://a.example', citation: '"Alpha". The Guardian. 2024.', content: 'Source Content:\nAlpha body.' },
    { url: 'https://b.example', citation: '"Beta". Le Monde.', content: null, status: 403 },
    { url: 'https://c.example', content: 'Source Content:\nGamma body.' },
  ]);
  assert.equal(text, [
    'Source (https://a.example):', 'Citation (as given in the article): "Alpha". The Guardian. 2024.', 'Alpha body.',
    '',
    'Source (https://b.example):', 'Citation (as given in the article): "Beta". Le Monde.', '[This source could not be retrieved: HTTP 403]',
    '',
    'Source (https://c.example):', 'Gamma body.',
  ].join('\n'));
});

test('generateGroupUserPrompt adds today\'s date only when given', () => {
  assert.match(generateGroupUserPrompt('C', 'SOURCES', { today: '2026-11-15' }), /^Claim: "C"\n\nToday's date: 2026-11-15\n\nThe following sources/);
  assert.equal(generateGroupUserPrompt('C', 'SOURCES'), generateGroupUserPrompt('C', 'SOURCES', {}));
  assert.ok(!generateGroupUserPrompt('C', 'SOURCES').includes("Today's date"));
});

test('groupSourceEntries keeps the first member\'s citation for a shared source', () => {
  const entries = groupSourceEntries(
    [{ citationNumber: '1', c: 'First.' }, { citationNumber: '2', c: 'Second.' }],
    m => ({ key: 'same', url: 'https://x', citation: m.c })
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].citation, 'First.');
});

test('todayIsoDate is the local calendar date, zero-padded', () => {
  assert.equal(todayIsoDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(todayIsoDate(new Date(2026, 10, 15, 0, 1)), '2026-11-15');
  assert.match(todayIsoDate(), /^\d{4}-\d{2}-\d{2}$/);
});

// --- front ends pass them through ---

const SUPPORTED = { support_score: 95, verdict: 'SUPPORTED', source_quote: '', comments: 'ok' };

test('core/pipeline.js sends the citation, the cited URL and today\'s date', async () => {
  let seen;
  await verifyCitation({
    claimText: 'A claim.',
    sourceUrl: 'https://example.com/a',
    citationText: '"A". Example Times. 2024.',
    provider: 'claude',
    fetchSource: async () => ({ content: 'Source URL: https://example.com/a\n\nSource Content:\nBody text.', status: 200 }),
    callProvider: async (_name, config) => { seen = config.userContent; return { text: JSON.stringify(SUPPORTED) }; },
  });
  assert.match(seen, /\nCitation \(as given in the article\): "A"\. Example Times\. 2024\.\nSource URL: https:\/\/example\.com\/a\nToday's date: \d{4}-\d{2}-\d{2}\n\nSource text:\nBody text\.$/);
});

test('core/pipeline.js takes an explicit today', async () => {
  let seen;
  await verifyCitation({
    claimText: 'A claim.', sourceContent: 'pasted', today: '2020-02-02', provider: 'claude',
    callProvider: async (_name, config) => { seen = config.userContent; return { text: JSON.stringify(SUPPORTED) }; },
  });
  assert.equal(seen, 'Claim: "A claim."\n\nToday\'s date: 2020-02-02\n\nSource text:\npasted');
});

test('service/verifier.js sends citation details for a solo check and per source for a group', async () => {
  let solo;
  await verifyBatchCitation('The bridge was completed in 1998.', { content: 'Source Content:\nBody.', status: 200 }, {
    citationText: '"Bridge opens". City Tribune. 1998.', sourceUrl: 'https://tribune.example/bridge', today: '2026-11-15',
    callModel: async (_system, user) => { solo = user; return { text: JSON.stringify(SUPPORTED), usage: {} }; },
  });
  assert.match(solo, /Citation \(as given in the article\): "Bridge opens"\. City Tribune\. 1998\.\nSource URL: https:\/\/tribune\.example\/bridge\nToday's date: 2026-11-15/);

  const member = (n, referenceText) => ({
    citationNumber: n, claimText: 'The bridge, built in 1998, cost $200 million.', url: `https://example.com/${n}`,
    referenceText, groupId: 'g', groupSize: 2, groupIndex: Number(n) - 1,
    source: { content: `Source Content:\nBody ${n}.`, status: 200, error: null },
  });
  let group;
  await verifyGroup([member('1', '"One". Paper A.'), member('2', null)], {
    today: '2026-11-15',
    callModel: async (_system, user) => { group = user; return { text: JSON.stringify(SUPPORTED), usage: {} }; },
  });
  assert.match(group, /Today's date: 2026-11-15/);
  assert.match(group, /Source \(https:\/\/example\.com\/1\):\nCitation \(as given in the article\): "One"\. Paper A\.\nBody 1\./);
  assert.match(group, /Source \(https:\/\/example\.com\/2\):\nBody 2\./);
});

// --- benchmark: dataset.json's citation_text ---

import { extractCitationTextForCitation } from '../benchmark/extract_dataset.js';
import { addCitationText } from '../benchmark/add_citation_text.js';

// extract_dataset.js keys rows on the displayed "[N]", the way the CSV does.
function numberedDoc() {
  return new JSDOM(`<!DOCTYPE html><body>
    <p>First claim.<sup class="reference"><a href="#cite_note-a-1">[1]</a></sup>
       Second claim.<sup class="reference"><a href="#cite_note-b-2">[2]</a></sup>
       Reused.<sup class="reference"><a href="#cite_note-a-1">[1]</a></sup></p>
    <ol class="references">
      <li id="cite_note-a-1"><span class="mw-cite-backlink">↑ a b</span> <span class="reference-text">"Alpha". The Times. 2020.</span></li>
      <li id="cite_note-b-2"><span class="mw-cite-backlink">↑</span> <span class="reference-text">"Beta". Le Monde. 2021.</span></li>
    </ol></body>`).window.document;
}

test('extractCitationTextForCitation finds the footnote by its displayed number', () => {
  const doc = numberedDoc();
  assert.equal(extractCitationTextForCitation(doc, 1), '"Alpha". The Times. 2020.');
  assert.equal(extractCitationTextForCitation(doc, 1, 2), '"Alpha". The Times. 2020.');
  assert.equal(extractCitationTextForCitation(doc, 2), '"Beta". Le Monde. 2021.');
  assert.equal(extractCitationTextForCitation(doc, 9), null);
  assert.equal(extractCitationTextForCitation(null, 1), null);
});

test('addCitationText fills rows once per article, keeps existing values, and records misses', async () => {
  const rows = [
    { id: 'r1', article_url: 'A', citation_number: 1, occurrence: 1 },
    { id: 'r2', article_url: 'A', citation_number: 2, occurrence: 1 },
    { id: 'r3', article_url: 'A', citation_number: 7, occurrence: 1 },
    { id: 'r4', article_url: 'B', citation_number: 1, occurrence: 1, citation_text: 'kept' },
    { id: 'r5', article_url: 'C', citation_number: 1, occurrence: 1 },
  ];
  const loads = [];
  const summary = await addCitationText(rows, {
    loadDocument: async url => {
      loads.push(url);
      if (url === 'C') throw new Error('HTTP 503');
      return numberedDoc();
    },
  });
  assert.deepEqual(loads, ['A', 'C'], 'one fetch per article, none for a row already filled');
  assert.deepEqual(rows.map(r => r.citation_text), ['"Alpha". The Times. 2020.', '"Beta". Le Monde. 2021.', null, 'kept', undefined]);
  assert.deepEqual(summary, { filled: 2, missing: 1, skipped: 1, failedArticles: ['C'] });
});

// --- the HTTP API's optional `citation` field ---

import { verifyRequest, validateVerifyRequest, MAX_CITATION_CHARS } from '../api/verify.js';

test('POST /v1/verify forwards `citation` to the model and validates it', async () => {
  let seen;
  const response = await verifyRequest(
    { claim: 'A claim.', source_content: 'Body text.', citation: '  "A". Example Times. 2024. ' },
    { workerBase: null, callProvider: async (_name, config) => { seen = config.userContent; return { text: JSON.stringify(SUPPORTED) }; } },
  );
  assert.equal(response.status, 200);
  assert.match(seen, /\nCitation \(as given in the article\): "A"\. Example Times\. 2024\.\n/);

  assert.equal(validateVerifyRequest({ claim: 'c', source_content: 's', citation: 5 }), 'citation must be a string');
  assert.match(validateVerifyRequest({ claim: 'c', source_content: 's', citation: 'x'.repeat(MAX_CITATION_CHARS + 1) }), /must not exceed/);
  assert.equal(validateVerifyRequest({ claim: 'c', source_content: 's', citation: 'ok' }), null);
});
