// Sentence splitting for the batch pipeline's sentence-scope claims.
//
// The userscript narrows a claim to its last sentence with a regex
// (core/claim.js's lastSentence()): split after . ! ? when the next word
// starts with a capital. That cannot tell an abbreviation or an initial from
// the end of a sentence, so "Поэму написал А. С. Пушкин в 1833 году." comes
// back as "Пушкин в 1833 году.", and "Dr. Smith", "в 1837 г. Пушкин" and
// "ул. Ленина" are cut the same way. In an unattended batch that is a claim
// checked with its subject missing.
//
// sentencex (github.com/wikimedia/sentencex, MIT) is Wikimedia's own
// segmenter, written for Wikipedia text: the same split-then-suppress design
// as pySBD or razdel, with maintained abbreviation lists for ~244 languages
// and fallback chains between related ones. It is a native Node module, so it
// is used here and not in core/ — core/claim.js runs in the browser too.
// Unknown language codes fall back to its generic rules rather than failing.

import { segment } from 'sentencex';

export function sentencexLastSentence(langCode = 'en') {
    return text => {
        if (!text) return text;
        const sentences = segment(langCode, text)
            .map(s => s.trim())
            .filter(Boolean);
        return sentences.length ? sentences[sentences.length - 1] : text.trim();
    };
}
