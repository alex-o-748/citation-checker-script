// Regression tests for core/body-classifier.js.
//
// Each fixture is a real Defuddle output from the combined-integration
// benchmark where both Sonnet 4.5 and Opus 4.7 returned "Source unavailable"
// against a GT of "Not supported" — i.e., cases the classifier should catch
// so the pipeline returns SU mechanically and the LLM never has to guess.
// The "usable" fixtures are sampled from rows where both models produced the
// GT-matching verdict — bodies the pipeline demonstrably handled end-to-end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBody } from '../core/body-classifier.js';

// ===== Unusable bodies — classifier must catch =====

test('row_94: Wayback wrapper for Croydon Minster (short, chrome-dominated)', () => {
  const text = 'The Wayback Machine - https://web.archive.org/web/20120324190450/http://www.croydonminster.org/about-us A Living Past and a Growing Future If you want to help us support Croydon Minster, you can donate online through JustGiving.';
  assert.deepEqual(classifyBody(text), { usable: false, reason: 'wayback_chrome' });
});

test("row_17: Wayback captures-only page (PDF didn't extract)", () => {
  const text = '45 captures 05 Feb 2021 - 28 Jan 2026 Aug SEP Oct 10 2021 2022 2023 success fail About this capture COLLECTED BY Collection: Wikipedia Eventstream TIMESTAMPS The Wayback Machine - https://web.archive.org/web/20220910221959/https://www2.census.gov/library/publications/decennial/1900/century-of-growth';
  assert.deepEqual(classifyBody(text), { usable: false, reason: 'wayback_chrome' });
});

test('row_64: Wayback collection-metadata-only page', () => {
  const text = 'Aug SEP Oct 24 2022 2023 2024 COLLECTED BY Collection: Common Crawl Web crawl data from Common Crawl. The Wayback Machine - http://web.archive.org/web/20230924034658/https://almeezan.qa/LawArticles.aspx';
  assert.deepEqual(classifyBody(text), { usable: false, reason: 'wayback_chrome' });
});

test('row_22: Internet Archive HTTP-301 redirect notice', () => {
  const text = 'About Blog Events Projects Help Donate Donate icon An illustration of a heart shape Contact Jobs Volunteer Loading... http://seattletimes.nwsource.com/html/nationworld/2003265600_impghistory20.html | 20:20:25 October 15, 2012 Got an HTTP 301 response at crawl time Redirecting to... http://seattletimes.com/html/nationworld/2003265600_impghistory20.html';
  assert.deepEqual(classifyBody(text), { usable: false, reason: 'wayback_redirect_notice' });
});

test('row_70: JSON-LD schema.org blob (el Heraldo)', () => {
  const text = '{ "@context": "https://schema.org", "@type": "NewsArticle", "mainEntityOfPage": "https://www.elheraldo.hn/honduras/corte-apelaciones-admite-recurso-apelacion-alcalde-nasry-tito-asfura-corrupcion-GXEH1467634", "name": "Sala Penal ordena anular acciones penales contra Nasry \'Tito\' Asfura"';
  assert.deepEqual(classifyBody(text), { usable: false, reason: 'json_ld_leak' });
});

test('row_146: CSS stylesheet content (almerja.com)', () => {
  const text = '#header{ position: sticky; top: 0; z-index: 10; background-color: rgba(0961511); border-bottom: 3px solid #008ec5; padding: 0px 20px; display: flex; align-items: center; justify-content:space-around; color: #fff; user-select: none; } #header #h_r{ display: flex; align-items: center; padding: 5px; } #header #h_r p:nth-child(1){ width: 35px; height: 35px; background-color: #fff; border-radius: 50%; margin-left: 10px; display: flex; align-items: center; text-align: center; } #header #h_r p a{ display: flex; align-items: center; }';
  assert.deepEqual(classifyBody(text), { usable: false, reason: 'css_leak' });
});

test('row_134: Amazon page rendered as footer-only stub', () => {
  const text = 'Click the button below to continue shopping Conditions of Use & Sale Privacy Notice © 1996-2025, Amazon.com, Inc. or its affiliates';
  assert.deepEqual(classifyBody(text), { usable: false, reason: 'amazon_stub' });
});

test('row_92: Author contact page (too short)', () => {
  const text = 'CB-Forrest-Author-Logo Reach out to C.B. Forrest on Twitter – @cbforrest. Get in Touch Connect Please follow or message C.B. Forrest on Twitter. Twitter Hours Direct message replies on Twitter: Mon-Fri 09:00-19:00 Scroll to Top';
  assert.deepEqual(classifyBody(text), { usable: false, reason: 'short_body' });
});

test('row_144: Anubis proof-of-work anti-bot challenge (eBird)', () => {
  const text = 'Making sure you&#39;re not a bot! Loading... Why am I seeing this? You are seeing this because the administrator of this website has set up Anubis to protect the server against the scourge of AI companies aggressively scraping websites.';
  assert.deepEqual(classifyBody(text), { usable: false, reason: 'anti_bot_challenge' });
});

// ===== Usable bodies — must NOT be flagged =====
// Sampled from rows where both Sonnet 4.5 and Opus 4.7 produced the
// GT-matching verdict in the combined-integration benchmark — i.e.,
// bodies the pipeline demonstrably handled end-to-end. Includes Wayback-
// prefix + real-article (row_9, common shape), short news prose, long
// article bodies, RTL/Arabic text, and a Forbes-style intro.

test('row_9: Wayback URL prefix + real USCIS glossary article (must pass — chrome is short)', () => {
  const text = 'The Wayback Machine - https://web.archive.org/web/20160121232201/http://www.uscis.gov/tools/glossary/country-limit The maximum number of family-sponsored and employment-based preference visas that can be issued to citizens of any country in a fiscal year. The limits are calculated each fiscal year depending on the total number of family-sponsored and employment-based visas available. No more than 7 percent of the visas may be issued to natives of any one independent country in a fiscal year; no more than 2 percent may issued to any one dependency of any independent country. The per-country limit does not indicate, however, that a country is entitled to the maximum number of visas each year, just that it cannot receive more than that number. Because of the combined workings of the preference system and per-country limits, most countries do not reach this level of visa issuance. Last Reviewed/Updated:';
  assert.deepEqual(classifyBody(text), { usable: true, reason: 'ok' });
});

test('row_14: News opinion piece (medium-length)', () => {
  const text = 'As his price for not deporting roughly 800000 "Dreamers" who came to this country as children, Donald Trump demands an escalated war against immigrants, topped by his nightmarish 2000-mile wall along the Mexican border. Democrats have said no. Whether or not some sort of deal is eventually struck, the larger story of the past several decades is that the long-running drive to keep America Caucasian — the dream of a "Christian nation" of European descent — is failing definitively.';
  assert.deepEqual(classifyBody(text), { usable: true, reason: 'ok' });
});

test('row_104: Local-news article (substantive prose, 1.4k chars)', () => {
  const text = 'CIRCLEVILLE – Rax Roast beef restaurants were much like Arbys back in the 80s and 90s but where one became a huge giant the other shrunk to only a handful of stores, one that still exists is right here in Circleville Ohio. In the Hayday Rax had as many as 504 locations across the US in 38 states and now there are only seven still operating. The history of the chain dates back to 1967.';
  assert.deepEqual(classifyBody(text), { usable: true, reason: 'ok' });
});

test('row_91: Arabic article (must not trip on non-Latin scripts)', () => {
  const text = 'عملية الاغتيال جرت برصاصة واحدة أطلقت عليه من مسافة قريبة من إحدى نوافذ منزله سوريا قتل قائد فصيل محلي في محافظة السويداء السورية، صباح الأربعاء، وذكرت التحقيقات الأولية بإقدام مجهولين على قتله داخل منزله وباستخدام سلاح كاتم صوت. والقيادي القتيل هو قائد فصيل "لواء الجبل"، مرهج الجرماني.وقالت شبكة "السويداء 24"، إن عملية الاغتيال جرت برصاصة واحدة أطلقت عليه من مسافة قريبة من إحدى نوافذ منزله خلال نومه.والجرماني كان قائد فصيل محلي في السويداء السورية وينشط منذ عام 2014 باسم "لواء الجبل".';
  assert.deepEqual(classifyBody(text), { usable: true, reason: 'ok' });
});

test('row_189: Real Goodreads book description (short but substantive)', () => {
  const text = "Jump to ratings and reviews Rate this book Marjane Satrapi Rate this book From the author of Persepolis, comes this illustrated fairy tale. Rose is one of three daughters of a rich merchant who always brings gifts for his girls from the market. One day Rose asks for the seed of a blue bean, but he fails to find one for her. She lets out a sigh in resignation, and her sigh attracts the Sigh, a mysterious being that brings the seed she desired to the merchant. But every debt has to be paid, and every gift has a price, and the Sigh returns a year later to take the merchant's daughter to a secret and distant palace.56 pages, Hardcover First published January 1, 2004";
  assert.deepEqual(classifyBody(text), { usable: true, reason: 'ok' });
});

test('row_125: Real Museo Novecento exhibition page', () => {
  const text = 'From 17 June to 2 November 2022 the Museo Novecento hosts Corrado Cagli. Copernican Artist, an exhibition curated by Eva Francioli, Francesca Neri and Stefania Rispoli. Exhibition Hours Museo Novecento With this new exhibition project, the Museo Novecento continues its activity of enhancing the artists present within the Florentine civic collections. A scientific project started in 2018 with the exhibition dedicated to Emilio Vedova and continued with monographs dedicated, among others, to Mirko Basaldella, Mario Mafai, Arturo Martini, of which a large number of works are present in the permanent collection.';
  assert.deepEqual(classifyBody(text), { usable: true, reason: 'ok' });
});

test('row_8: Real DHS statistical-table prose (long)', () => {
  const text = 'The is a compendium of tables that provide data on foreign nationals who are granted lawful permanent residence (i.e., immigrants who receive a "green card"), admitted as temporary nonimmigrants, granted asylum or refugee status, or are naturalized. The Yearbook also presents data on immigration enforcement actions, including apprehensions and arrests, removals, and returns. Family-Sponsored Preferences Type and class of admission Total Adjustments of Status New Arrivals Total, all immigrants 1183505 565427 618078 Family-sponsored preferences 238087 15116 222971';
  assert.deepEqual(classifyBody(text), { usable: true, reason: 'ok' });
});

test('row_98: Real Forbes article about Zogby and housing trends', () => {
  const text = "This article is more than 8 years old. Cabin in woods Cara Fuller, Unsplash Back in 2008 John Zogby, author, founder of the Zogby International Poll and a fellow Forbes.com contributor, predicted a seismic shift in American's aspirations, values and ideals in his book The Way We'll Be: The Zogby Report on the Transformation of the American Dream.";
  assert.deepEqual(classifyBody(text), { usable: true, reason: 'ok' });
});

// ===== Edge cases =====

test('edge: empty string', () => {
  assert.deepEqual(classifyBody(''), { usable: false, reason: 'short_body' });
});

test('edge: null', () => {
  assert.deepEqual(classifyBody(null), { usable: false, reason: 'short_body' });
});

test('edge: leading whitespace + short content', () => {
  assert.deepEqual(classifyBody('   \n\n  Brief contact page.   '), { usable: false, reason: 'short_body' });
});
