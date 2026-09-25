import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sentencexLastSentence } from '../service/sentences.js';
import { lastSentence } from '../core/claim.js';

// The cases the regex splitter gets wrong: an abbreviation or an initial
// followed by a capital. sentencex must keep each whole.
const ABBREVIATION_CASES = [
    ['ru', 'Поэму написал А. С. Пушкин в 1833 году.'],
    ['ru', 'В 1837 г. Пушкин погиб на дуэли.'],
    ['ru', 'Он жил на ул. Ленина в Москве.'],
    ['en', 'It was built by Dr. Smith in 1900.'],
    ['en', 'It was written by J. R. R. Tolkien in 1937.'],
];

for (const [lang, text] of ABBREVIATION_CASES) {
    test(`sentencexLastSentence (${lang}) keeps "${text}" whole`, () => {
        assert.equal(sentencexLastSentence(lang)(text), text);
        // Pins why the batch pipeline doesn't use the regex: if this starts
        // passing, the regex caught up and the dependency can be revisited.
        assert.notEqual(lastSentence(text), text);
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
