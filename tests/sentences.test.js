import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sentencexLastSentence } from '../service/sentences.js';
import { lastSentence } from '../core/claim.js';

// An abbreviation or an initial followed by a capital. Both splitters must
// keep each whole. Until 2026-10-23 the userscript's regex cut every one of
// these (and this test pinned that gap); it now carries the initials and
// abbreviation rules in core/claim.js. The batch pipeline still uses
// sentencex, whose lists cover ~244 languages rather than the sidebar's five.
const ABBREVIATION_CASES = [
    ['ru', 'Поэму написал А. С. Пушкин в 1833 году.'],
    ['ru', 'В 1837 г. Пушкин погиб на дуэли.'],
    ['ru', 'Он жил на ул. Ленина в Москве.'],
    ['en', 'It was built by Dr. Smith in 1900.'],
    ['en', 'It was written by J. R. R. Tolkien in 1937.'],
];

for (const [lang, text] of ABBREVIATION_CASES) {
    test(`sentencexLastSentence (${lang}) and lastSentence keep "${text}" whole`, () => {
        assert.equal(sentencexLastSentence(lang)(text), text);
        assert.equal(lastSentence(text), text);
    });
}

test('sentencexLastSentence still splits real sentence boundaries', () => {
    assert.equal(sentencexLastSentence('ru')('Он приехал в Москву. Там он учился.'), 'Там он учился.');
    assert.equal(
        sentencexLastSentence('ru')('Проезд оплачивают картами. Недавно появились браслеты'),
        'Недавно появились браслеты',
    );
    assert.equal(sentencexLastSentence('en')('Paris is the capital of France. It is on the Seine.'), 'It is on the Seine.');
});

test('sentencexLastSentence handles empty input and unknown language codes', () => {
    assert.equal(sentencexLastSentence('ru')(''), '');
    assert.equal(sentencexLastSentence('xx')('One. Two.'), 'Two.');
});
