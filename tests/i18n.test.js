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

// `mw` and `document` are constructor parameters rather than globals, so
// passing `undefined` exercises the non-MediaWiki / no-DOM fallback paths
// faithfully.
function loadI18n(mwStub, documentStub) {
  const build = new Function('mw', 'document', `
${I18N_BLOCK}
    class Harness {
      constructor(lang, articleLangCode) {
        this.lang = lang === undefined ? detectUiLang() : lang;
        this.articleLangCode = articleLangCode === undefined ? detectArticleLangCode() : articleLangCode;
      }
${T_METHOD}
${LOCALIZE_METHOD}
    }
    return { MESSAGES, PROMPT_LANGUAGES, RTL_LANGS, detectUiLang, detectArticleLangCode, detectDockSide, Harness };
  `);
  return build(mwStub, documentStub);
}

function wikiWithLang(contentLanguage, userLanguage) {
  return { config: { get: (k) => (k === 'wgContentLanguage' ? contentLanguage : userLanguage) } };
}

const { MESSAGES, PROMPT_LANGUAGES, RTL_LANGS, Harness } = loadI18n(undefined);
const LANGS = Object.keys(MESSAGES);

// Placeholders are substituted by t() via a literal `{name}` split, so a
// translation that drops or renames one silently leaves `{count}` on screen.
// `{{template}}` (double-braced MediaWiki template calls, e.g. '{{tick}}')
// is a different thing entirely — literal wikitext never passed through
// t()'s params, and it may legitimately need a different template name per
// language (e.g. fr's '{{Oui-}}' in place of '{{tick}}') — so it's excluded
// via the lookaround guards.
function placeholders(s) {
  return new Set([...String(s).matchAll(/(?<!\{)\{([a-zA-Z]+)\}(?!\})/g)].map((m) => m[1]));
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
  // A handful of strings are genuinely the same word in Spanish, and the tool's
  // name is a name — it reads identically in every language, on purpose.
  // Anything else matching English means a key was copied over without being
  // translated.
  const SAME_IN_SPANISH = ['No', 'Source Verifier', 'ERROR', 'Error: {message}'];
  const untranslated = Object.entries(MESSAGES.es).filter(([en, es]) => en === es);
  assert.deepEqual(untranslated.map(([en]) => en), SAME_IN_SPANISH, 'untranslated Spanish strings');
});

// es.wikipedia's interface never addresses the reader in the second person —
// tú, vos and usted are each regionally marked. This catches only the
// unmistakable markers: pronouns, possessives, and verb forms with no
// third-person reading. It is a smoke alarm, not a grammar checker — the
// register guidance lives in the comment above ES_MESSAGES, and anything
// subtler than this is better caught by a human reading the strings.
const SECOND_PERSON_ES =
  /\b(?:tu|tus|ti|tuyo|tuya|tuyos|tuyas|vos|usted|ustedes|quieres|puedes|debes|tienes|pegues|dudes|haz|hazlo)\b/i;

test('Spanish never addresses the reader in the second person', () => {
  const offenders = [];
  for (const [en, es] of Object.entries(MESSAGES.es)) {
    const hit = es.match(SECOND_PERSON_ES);
    if (hit) offenders.push(`${JSON.stringify(en)} → ${JSON.stringify(es)} (${hit[0]})`);
  }
  assert.deepEqual(offenders, [], `use an infinitive or impersonal "se" instead:\n${offenders.join('\n')}`);
});

test('Hebrew is a registered, right-to-left UI language', () => {
  assert.ok(LANGS.includes('he'), 'he missing from MESSAGES');
  assert.equal(PROMPT_LANGUAGES.he, 'Hebrew (עברית)');
  assert.ok(RTL_LANGS.has('he'), 'he must be marked right-to-left');
  for (const lang of ['en', 'fr', 'es', 'ru']) assert.ok(!RTL_LANGS.has(lang), `${lang} is not RTL`);
  for (const lang of RTL_LANGS) assert.ok(LANGS.includes(lang), `RTL language ${lang} has no MESSAGES table`);
});

// Hebrew imperatives and second-person forms are gendered (לחץ / לחצי), so
// he.wikipedia's interface avoids them: verbal nouns for action labels,
// impersonal "יש ל…" / "אפשר ל…" for prose. Like the Spanish check above,
// this is a smoke alarm for the unmistakable forms, not a grammar checker —
// masculine forms that double as an adjective or past tense (שמור "stored",
// בחר "chose", העלה "raised") are left out.
// Hebrew letters aren't \w, so \b can't mark word edges; \p{L} lookarounds do.
const SECOND_PERSON_HE =
  /(?<!\p{L})(?:אתה|את\s+יכולה|לחץ|לחצי|הקש|הקישי|בחרי|הזן|הזיני|הדבק|הדביקי|נסה|נסי|העלי|שמרי)(?!\p{L})/u;

test('Hebrew never addresses the reader with a gendered second person', () => {
  const offenders = [];
  for (const [en, he] of Object.entries(MESSAGES.he)) {
    const hit = he.match(SECOND_PERSON_HE);
    if (hit) offenders.push(`${JSON.stringify(en)} → ${JSON.stringify(he)} (${hit[0]})`);
  }
  assert.deepEqual(offenders, [], `use a verbal noun or "יש ל…" + infinitive instead:\n${offenders.join('\n')}`);
});

test('detectUiLang resolves he.wikipedia to Hebrew', () => {
  assert.equal(loadI18n(wikiWithLang('he', 'en')).detectUiLang(), 'he');
  assert.equal(loadI18n(wikiWithLang(null, 'he')).detectUiLang(), 'he');
  assert.equal(loadI18n(wikiWithLang('en', 'he')).detectUiLang(), 'en', 'content language wins');
});

test('detectDockSide docks to the left on an RTL page and to the right otherwise', () => {
  const page = (dir) => ({ documentElement: { dir } });
  assert.equal(loadI18n(undefined, page('rtl')).detectDockSide(), 'left');
  assert.equal(loadI18n(undefined, page('RTL')).detectDockSide(), 'left');
  assert.equal(loadI18n(undefined, page('ltr')).detectDockSide(), 'right');
  assert.equal(loadI18n(undefined, page('')).detectDockSide(), 'right');
  assert.equal(loadI18n(undefined, undefined).detectDockSide(), 'right', 'no DOM keeps the default side');
});

test('wiki links in translated strings point at the English wiki', () => {
  // The script's user page only exists on en.wikipedia, so an unprefixed
  // [[User:…]] in a report or edit summary is a redlink on every other wiki.
  // The English keys stay unprefixed — there the local link is the right one.
  const offenders = [];
  for (const lang of LANGS) {
    for (const [en, translated] of Object.entries(MESSAGES[lang])) {
      if (/\[\[(?!:en:)User[ _]?(talk)?:/i.test(translated)) offenders.push(`${lang}: ${JSON.stringify(en)}`);
    }
  }
  assert.deepEqual(offenders, [], 'use [[:en:User:…]] in translated strings');
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

test('localizeSystemPrompt names the language for localized UIs', () => {
  const base = 'SYSTEM PROMPT';
  // English wiki, no article-language signal: prompt stays verbatim.
  assert.equal(new Harness('en', 'en').localizeSystemPrompt(base), base, 'English must get the prompt verbatim');
  assert.equal(new Harness('en', null).localizeSystemPrompt(base), base, 'no detected article language: prompt verbatim');

  for (const lang of LANGS) {
    const out = new Harness(lang, lang).localizeSystemPrompt(base);
    assert.ok(out.startsWith(base), `${lang}: the benchmark-tuned prompt must be left intact`);
    assert.ok(out.includes(PROMPT_LANGUAGES[lang]), `${lang}: directive does not name the language`);
    // The verdict enum is parsed programmatically and must stay English.
    assert.ok(out.includes('SOURCE UNAVAILABLE'), `${lang}: directive drops the English verdict enum`);
  }

  assert.ok(new Harness('es', 'es').localizeSystemPrompt(base).includes('Spanish (español)'));
});

// Non-English wikis with no full sidebar translation (e.g. de, ja) still get
// a language directive — just a generic one, since there's no curated name
// to plug in. This is the fix for comments coming back in English "no matter
// which language article is being checked".
test('localizeSystemPrompt falls back to a generic directive for wikis without a UI table', () => {
  const base = 'SYSTEM PROMPT';
  for (const code of ['de', 'ja', 'pt-br', 'zh']) {
    const out = new Harness('en', code).localizeSystemPrompt(base);
    assert.ok(out.startsWith(base), `${code}: the benchmark-tuned prompt must be left intact`);
    assert.ok(/same language as the claim/i.test(out), `${code}: expected a generic language directive`);
    assert.ok(out.includes('SOURCE UNAVAILABLE'), `${code}: directive drops the English verdict enum`);
  }
});

test('detectArticleLangCode reads the raw wiki content language, unrestricted to UI-translated languages', () => {
  assert.equal(loadI18n(wikiWithLang('de', 'en')).detectArticleLangCode(), 'de');
  assert.equal(loadI18n(wikiWithLang('es', 'en')).detectArticleLangCode(), 'es');
  assert.equal(loadI18n(wikiWithLang(null, 'ja')).detectArticleLangCode(), 'ja');
  assert.equal(loadI18n(wikiWithLang(null, null)).detectArticleLangCode(), null);
  assert.equal(loadI18n(undefined).detectArticleLangCode(), null, 'non-MediaWiki context has no article language');
});
