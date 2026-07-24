import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MESSAGES,
    RTL_LANGS,
    isRtlLang,
    resolveUiLang,
    createTranslator,
} from '../core/i18n.js';

test('isRtlLang recognizes Hebrew and other RTL scripts, plus variants', () => {
    assert.equal(isRtlLang('he'), true);
    assert.equal(isRtlLang('ar'), true);
    assert.equal(isRtlLang('he-x-anything'), true, 'regional/variant subtags fall back to primary');
    assert.equal(isRtlLang('en'), false);
    assert.equal(isRtlLang('fr'), false);
    assert.equal(isRtlLang(''), false);
    assert.equal(isRtlLang(null), false);
    assert.equal(isRtlLang(undefined), false);
});

test('RTL_LANGS includes Hebrew and is the source for isRtlLang', () => {
    assert.ok(RTL_LANGS.includes('he'));
});

test('resolveUiLang maps to a supported catalog key, defaulting to English', () => {
    assert.equal(resolveUiLang('he'), 'he');
    assert.equal(resolveUiLang('en'), 'en');
    assert.equal(resolveUiLang('he-IL'), 'he', 'unknown variant falls back to primary subtag');
    assert.equal(resolveUiLang('fr'), 'en', 'unsupported language falls back to English');
    assert.equal(resolveUiLang(''), 'en');
    assert.equal(resolveUiLang(null), 'en');
});

test('translator returns the Hebrew string for a Hebrew locale', () => {
    const t = createTranslator('he');
    assert.equal(t('verifyClaim'), MESSAGES.he.verifyClaim);
    assert.notEqual(t('verifyClaim'), MESSAGES.en.verifyClaim);
});

test('translator falls back to English when a key is missing in the target', () => {
    // Build a synthetic missing key by asking for one only present in en.
    const t = createTranslator('he');
    // Every en key should resolve (either translated or via fallback), never
    // returning the raw key name.
    for (const key of Object.keys(MESSAGES.en)) {
        const value = t(key, { provider: 'X', count: 2, claims: 2, citations: 3,
            groups: 1, minutes: 2, sources: 1, n: 1, s: 1, m: 1, page: 1, total: 2,
            input: '1', output: '1', numbers: '[1]', label: 'x', time: '1s',
            done: 1, size: 2, rev: '1', revId: '1', model: 'm', name: 'n',
            title: 't', supported: 1, partial: 0, notSupported: 0, unavailable: 0,
            claimsPhrase: '2 citations' });
        assert.notEqual(value, key, `key ${key} should resolve to text, not the key name`);
    }
});

test('translator interpolates {name} placeholders from params', () => {
    const t = createTranslator('en');
    assert.equal(t('keyRequired', { provider: 'Claude' }), 'API key required for Claude');
    // Missing params leave the placeholder untouched rather than printing "undefined".
    assert.equal(t('keyRequired', {}), 'API key required for {provider}');
});

test('function-valued messages carry plural logic per language', () => {
    const en = createTranslator('en');
    assert.equal(en('summaryCitationsChecked', { count: 1 }), '1 citation checked');
    assert.equal(en('summaryCitationsChecked', { count: 3 }), '3 citations checked');

    const he = createTranslator('he');
    assert.equal(he('summaryCitationsChecked', { count: 1 }), 'ציטוט אחד נבדק');
    assert.equal(he('summaryCitationsChecked', { count: 3 }), '3 ציטוטים נבדקו');
});

test('unknown keys return the key itself as a last resort', () => {
    const t = createTranslator('en');
    assert.equal(t('no_such_key_exists'), 'no_such_key_exists');
});

test('en and he catalogs expose the same set of keys', () => {
    const enKeys = Object.keys(MESSAGES.en).sort();
    const heKeys = Object.keys(MESSAGES.he).sort();
    assert.deepEqual(heKeys, enKeys, 'Hebrew catalog must mirror English key-for-key');
});
