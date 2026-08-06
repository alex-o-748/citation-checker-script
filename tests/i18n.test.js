import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');
const SRC = fs.readFileSync(MAIN_JS, 'utf8');

// main.js is a browser userscript wrapped in an IIFE that expects `mw`, so it
// can't be imported. As in styles.test.js, we lift the i18n block and the two
// methods that consume it out of the source and run them in isolation.
function sliceMethod(name, opening) {
  const start = SRC.indexOf(opening);
  assert.ok(start !== -1, `${name}() not found in main.js — did the method get renamed?`);
  const end = SRC.indexOf('\n        }\n', start);
  assert.ok(end !== -1, `could not find the end of ${name}()`);
  return SRC.slice(start, end + '\n        }'.length);
}

const I18N_START = SRC.indexOf('    const FR_MESSAGES = {');
const I18N_END = SRC.indexOf('    class WikipediaSourceVerifier {');
assert.ok(I18N_START !== -1, 'FR_MESSAGES not found in main.js');
assert.ok(I18N_END > I18N_START, 'WikipediaSourceVerifier not found after the i18n block');

const I18N_BLOCK = SRC.slice(I18N_START, I18N_END);
const T_METHOD = sliceMethod('t', '        t(en, params) {');
const LOCALIZE_METHOD = sliceMethod('localizeSystemPrompt', '        localizeSystemPrompt(prompt) {');

// `mw` is a constructor parameter rather than a global, so passing `undefined`
// exercises detectUiLang()'s non-MediaWiki fallback path faithfully.
function loadI18n(mwStub) {
  const build = new Function('mw', `
${I18N_BLOCK}
    class Harness {
      constructor(lang) { this.lang = lang === undefined ? detectUiLang() : lang; }
${T_METHOD}
${LOCALIZE_METHOD}
    }
    return { MESSAGES, PROMPT_LANGUAGES, detectUiLang, Harness };
  `);
  return build(mwStub);
}

function wikiWithLang(contentLanguage, userLanguage) {
  return { config: { get: (k) => (k === 'wgContentLanguage' ? contentLanguage : userLanguage) } };
}

const { MESSAGES, PROMPT_LANGUAGES, Harness } = loadI18n(undefined);
const LANGS = Object.keys(MESSAGES);

// Placeholders are substituted by t() via a literal `{name}` split, so a
// translation that drops or renames one silently leaves `{count}` on screen.
function placeholders(s) {
  return new Set([...String(s).matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]));
}

test('Spanish is a registered UI language', () => {
  assert.ok(LANGS.includes('es'), 'es missing from MESSAGES');
  assert.ok(LANGS.includes('fr'), 'fr missing from MESSAGES');
});

test('every language table covers the same keys', () => {
  const reference = Object.keys(MESSAGES.fr);
  for (const lang of LANGS) {
    const keys = new Set(Object.keys(MESSAGES[lang]));
    const missing = reference.filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !reference.includes(k));
    assert.deepEqual(missing, [], `${lang} is missing translations for: ${JSON.stringify(missing)}`);
    assert.deepEqual(extra, [], `${lang} has keys French does not: ${JSON.stringify(extra)}`);
  }
});

test('every language table has a prompt language name', () => {
  assert.deepEqual(Object.keys(PROMPT_LANGUAGES).sort(), LANGS.slice().sort());
});

test('translations preserve their placeholders', () => {
  for (const lang of LANGS) {
    for (const [en, translated] of Object.entries(MESSAGES[lang])) {
      assert.deepEqual(
        [...placeholders(translated)].sort(),
        [...placeholders(en)].sort(),
        `${lang} translation of ${JSON.stringify(en)} does not use the same placeholders`
      );
    }
  }
});

test('translations are non-empty and actually differ from English', () => {
  for (const lang of LANGS) {
    for (const [en, translated] of Object.entries(MESSAGES[lang])) {
      assert.equal(typeof translated, 'string', `${lang}: ${JSON.stringify(en)} is not a string`);
      assert.ok(translated.length > 0, `${lang}: ${JSON.stringify(en)} translates to an empty string`);
    }
  }
  // 'ERROR' and 'source' are genuinely identical in French; everything else
  // being identical would mean a key was copied without being translated.
  const untranslated = Object.entries(MESSAGES.es).filter(([en, es]) => en === es);
  assert.deepEqual(untranslated.map(([en]) => en), ['ERROR'], 'untranslated Spanish strings');
});

test('every this.t() key in main.js has a translation in every language', () => {
  const keys = new Set();
  for (const m of SRC.matchAll(/this\.t\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g)) {
    keys.add(JSON.parse(
      m[1][0] === "'"
        ? `"${m[1].slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`
        : m[1]
    ));
  }
  assert.ok(keys.size > 100, `expected the UI to use many t() strings, found ${keys.size}`);
  for (const lang of LANGS) {
    const missing = [...keys].filter((k) => MESSAGES[lang][k] == null);
    assert.deepEqual(missing, [], `${lang} is missing: ${JSON.stringify(missing)}`);
  }
});

test('detectUiLang picks the wiki content language', () => {
  assert.equal(loadI18n(wikiWithLang('es', 'en')).detectUiLang(), 'es');
  assert.equal(loadI18n(wikiWithLang('fr', 'en')).detectUiLang(), 'fr');
  assert.equal(loadI18n(wikiWithLang('en', 'es')).detectUiLang(), 'en');
  assert.equal(loadI18n(wikiWithLang('de', 'de')).detectUiLang(), 'en');
});

test('detectUiLang falls back to the user language and then to English', () => {
  assert.equal(loadI18n(wikiWithLang(null, 'es')).detectUiLang(), 'es');
  assert.equal(loadI18n(wikiWithLang(null, null)).detectUiLang(), 'en');
  assert.equal(loadI18n(undefined).detectUiLang(), 'en', 'non-MediaWiki context should stay English');
});

test('detectUiLang resolves regional variants but not unrelated codes sharing a prefix', () => {
  assert.equal(loadI18n(wikiWithLang('es-419', 'en')).detectUiLang(), 'es');
  assert.equal(loadI18n(wikiWithLang('ES', 'en')).detectUiLang(), 'es', 'matching should be case-insensitive');
  assert.equal(loadI18n(wikiWithLang('fr-ca', 'en')).detectUiLang(), 'fr');
  // frr (North Frisian), frp (Arpitan) and est (Estonian-ish codes) merely
  // start with a registered code — they are not French or Spanish wikis.
  assert.equal(loadI18n(wikiWithLang('frr', 'en')).detectUiLang(), 'en');
  assert.equal(loadI18n(wikiWithLang('frp', 'en')).detectUiLang(), 'en');
  assert.equal(loadI18n(wikiWithLang('esu', 'en')).detectUiLang(), 'en');
});

test('t() translates, falls back to English, and interpolates', () => {
  const es = new Harness('es');
  assert.equal(es.t('Verify Claim'), 'Verificar la afirmación');
  assert.equal(es.t('Provider: {name}', { name: 'Claude' }), 'Proveedor: Claude');
  assert.equal(es.t('a string nobody translated'), 'a string nobody translated');

  const en = new Harness('en');
  assert.equal(en.t('Verify Claim'), 'Verify Claim');
  assert.equal(en.t('Provider: {name}', { name: 'Claude' }), 'Provider: Claude');
});

test('localizeSystemPrompt appends a language directive only for localized UIs', () => {
  const base = 'SYSTEM PROMPT';
  assert.equal(new Harness('en').localizeSystemPrompt(base), base, 'English must get the prompt verbatim');

  for (const lang of LANGS) {
    const out = new Harness(lang).localizeSystemPrompt(base);
    assert.ok(out.startsWith(base), `${lang}: the benchmark-tuned prompt must be left intact`);
    assert.ok(out.includes(PROMPT_LANGUAGES[lang]), `${lang}: directive does not name the language`);
    // The verdict enum is parsed programmatically and must stay English.
    assert.ok(out.includes('SOURCE UNAVAILABLE'), `${lang}: directive drops the English verdict enum`);
  }

  assert.ok(new Harness('es').localizeSystemPrompt(base).includes('Spanish (español)'));
});
