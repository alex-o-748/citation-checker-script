import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wikitextToPlain, paragraphAt, openingParagraph, blankTemplates } from '../service/cards/knowledge.js';

const WIKITEXT = [
    '{{Short description|A tower}}',
    '{{Infobox building',
    '| name = Tower',
    '',
    '| built = {{date|1889}}',
    '}}',
    "The '''Eiffel Tower''' is a [[wrought iron|wrought-iron]] tower in [[Paris]].<ref name=a>{{cite web|url=x}}</ref>",
    '',
    '== History ==',
    '<!-- a note -->The tower was designed by Koechlin.<ref>x</ref> It was completed in 1889 as the [[Exposition Universelle (1889)|entrance arch]].<ref name=b/>',
    '',
    '* a list item',
].join('\n');

test('blankTemplates keeps offsets and newlines, nesting included', () => {
    const blanked = blankTemplates(WIKITEXT);
    assert.equal(blanked.length, WIKITEXT.length);
    assert.equal(blanked.split('\n').length, WIKITEXT.split('\n').length);
    assert.doesNotMatch(blanked, /Infobox|date\|1889|a note/);
});

test('wikitextToPlain drops footnotes, templates and markup, and keeps link labels', () => {
    assert.equal(
        wikitextToPlain("The '''tower''' is in [[Paris]].<ref>{{cite web|url=x}}</ref> See [https://a.example the site]."),
        'The tower is in Paris. See the site.',
    );
});

test('openingParagraph skips an infobox that spans blank lines', () => {
    assert.equal(openingParagraph(WIKITEXT), 'The Eiffel Tower is a wrought-iron tower in Paris.');
});

test('paragraphAt gives the plain paragraph holding an offset, and nothing for a list', () => {
    assert.equal(
        paragraphAt(WIKITEXT, WIKITEXT.indexOf('completed in 1889')),
        'The tower was designed by Koechlin. It was completed in 1889 as the entrance arch.',
    );
    assert.equal(paragraphAt(WIKITEXT, WIKITEXT.indexOf('a list item')), '');
    assert.equal(paragraphAt(WIKITEXT, WIKITEXT.indexOf('name = Tower')), '');
});
