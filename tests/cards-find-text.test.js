import { test } from 'node:test';
import assert from 'node:assert/strict';

import { locateInWikitext, sectionAt } from '../service/cards/find-text.js';

const claim = 'Combat Zone Wrestling (CZW) is an American independent professional wrestling promotion founded in 1999 by John Zandig.';
const span = { start: claim.indexOf('1999'), end: claim.indexOf('1999') + 4 };

const WIKITEXT = `{{Infobox wrestling promotion
| founded = 1999
}}
'''Combat Zone Wrestling''' ('''CZW''') is an American [[Independent circuit|independent]] [[professional wrestling]] promotion founded in 1999 by [[John Zandig]].<ref>{{cite web|year=1999}}</ref>

== History ==
<!-- == Not a heading == -->
In 1999 the promotion ran its first show.

=== Later years ===
More text.
`;

test('the search text is the shortest run around the flagged words that occurs exactly once', () => {
    const r = locateInWikitext(WIKITEXT, claim, span);
    // At least three words, words before the flagged ones first: "founded
    // in 1999" occurs once ("1999" alone occurs four times).
    assert.equal(r.findText, 'founded in 1999');
    assert.equal(WIKITEXT.indexOf(r.findText), r.offset);
    assert.deepEqual(r.section, { index: 0, title: null });
});

test('a sentence that has been changed is not found', () => {
    const fixed = WIKITEXT.replace('promotion founded in 1999 by', 'promotion founded in 1998 by');
    assert.equal(locateInWikitext(fixed, claim, span), null);
});

test('sections are counted the way section=N counts them, ignoring headings in comments', () => {
    assert.deepEqual(sectionAt(WIKITEXT, WIKITEXT.indexOf('first show')), { index: 1, title: 'History' });
    assert.deepEqual(sectionAt(WIKITEXT, WIKITEXT.indexOf('More text')), { index: 2, title: 'Later years' });
});

test('trailing punctuation is trimmed, but never into the flagged words', () => {
    const c = 'The team was led by Smith, Jones and Brown.';
    const s = { start: c.indexOf('Brown'), end: c.indexOf('Brown') + 5 };
    const r = locateInWikitext('The team was led by Smith, Jones and Brown.<ref>x</ref> Brown left.', c, s);
    assert.equal(r.findText, 'Jones and Brown');
});

test('a heading with a link is titled by its text', () => {
    const w = 'Lead.\n== [[Early life|Early]] years ==\nBody.';
    assert.deepEqual(sectionAt(w, w.indexOf('Body')), { index: 1, title: 'Early years' });
});
