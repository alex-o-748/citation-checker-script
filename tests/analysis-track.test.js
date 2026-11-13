import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFootnotes, precedingProse, flagsAfter, wikitextToPlain, stripTemplates } from '../analysis/lib/wikitext.js';
import { tokenize, alignSuffix, urlKeys, normalizeForUrlSearch, locateAnywhere, similarity } from '../analysis/lib/match.js';
import { makeTarget, prepareRevision, trackSuggestion, locateBaseline, CHANGE_KINDS } from '../analysis/lib/track.js';

const NYT = 'https://www.nytimes.com/2023/02/27/us/politics/supreme-court-identity-theft-law.html';

const BASE = `'''Dubin v. United States''' was a case.

In the case, the Court settled a [[circuit split]] regarding the reach of the federal aggravated identity theft statute.<ref name="nyt-certiorari">{{cite news |url=${NYT} |title=Justices weigh}}</ref> Oral arguments were heard on February 27, 2023.<ref>{{cite web |url=https://www.scotusblog.com/case-files/cases/dubin-v-united-states/ |title=Docket}}</ref>

Later text cites the same story again.<ref name="nyt-certiorari" />

== References ==
{{reflist}}
`;

const meta = (id, extra = {}) => ({
    rev_id: id, parent_id: id - 1, page_id: 1, timestamp: `2026-11-0${id % 9 + 1}T00:00:00Z`,
    user: 'Someone', tags: [], anon: false, temp: false, is_bot: false, ...extra,
});

const flaggedRow = {
    claim_text: 'In the case, the Court settled a circuit split regarding the reach of the federal aggravated identity theft statute.',
    ref_name: 'nyt-certiorari',
    source_url: NYT,
};
const supportedRow = {
    claim_text: 'Oral arguments were heard on February 27, 2023.',
    ref_name: '',
    source_url: 'https://www.scotusblog.com/case-files/cases/dubin-v-united-states/',
};

function track(row, revisions) {
    return trackSuggestion(makeTarget(row), prepareRevision(BASE), revisions.map((text, i) => ({
        meta: meta(101 + i),
        rev: text === null ? null : prepareRevision(text),
    })));
}

test('wikitextToPlain keeps link labels and drops templates, refs and markup', () => {
    assert.equal(
        wikitextToPlain(`'''Bold''' [[A|label]] and [[Plain]]{{cn}}<ref>x</ref> [https://x.org site] &ndash; {{nowrap|kept}}`).replace(/\s+/g, ' ').trim(),
        'Bold label and Plain site – kept',
    );
    assert.equal(stripTemplates('a {{outer|{{inner|x}}|y}} b'), 'a  b');
});

test('parseFootnotes finds refs, reuses and short-citation templates in order, with definitions for reuses', () => {
    const parsed = parseFootnotes('A.<ref name=a>{{cite web|url=https://e.org/1}}</ref> B.{{sfn|Smith|2001|p=4}} C.<ref name="a"/> <references/>');
    assert.deepEqual(parsed.markers.map(m => [m.kind, m.name]), [['ref', 'a'], ['template', null], ['ref', 'a']]);
    assert.match(parsed.markers[2].definition, /e\.org\/1/);
});

test('precedingProse gives every marker in an adjacent group the group\'s sentence', () => {
    const parsed = parseFootnotes('First sentence.<ref>a</ref> Grouped claim here.<ref>b</ref><ref>c</ref> Next.');
    assert.equal(precedingProse(parsed, 1).trim(), 'Grouped claim here.');
    assert.equal(precedingProse(parsed, 2).trim(), 'Grouped claim here.');
});

test('flagsAfter sees {{failed verification}} placed after a footnote, through other footnotes', () => {
    const parsed = parseFootnotes('Claim.<ref>a</ref><ref>b</ref>{{Failed verification|date=November 2026}} More.{{cn}}');
    assert.deepEqual(flagsAfter(parsed, 0), ['failed verification']);
    assert.deepEqual(flagsAfter(parsed, 1), ['failed verification']);
});

test('tokenize folds case, quotes and dashes', () => {
    assert.deepEqual(tokenize('“Ship” – USS Tampa—Bay'), ['ship', 'uss', 'tampa', 'bay']);
});

test('alignSuffix finds where a claim starts at the end of its paragraph', () => {
    const seg = tokenize('An earlier sentence about something else. The claim itself is here');
    const { start, score } = alignSuffix(seg, tokenize('The claim itself is here'));
    assert.equal(seg.slice(start).join(' '), 'the claim itself is here');
    assert.equal(score, 1);
});

test('urlKeys accepts the original behind a Wayback URL, and matches wikitext spelled differently', () => {
    const keys = urlKeys('https://web.archive.org/web/20100720184308/http://www.grasslandbeef.com/Detail.bok?no=507');
    assert.ok(keys.includes('grasslandbeef.com/detail.bok?no=507'));
    const body = normalizeForUrlSearch('{{cite web |url=http://www.grasslandbeef.com/Detail.bok?no=507 |archive-url=…}}');
    assert.ok(keys.some(k => body.includes(k)));
});

test('locateAnywhere tolerates a small edit and rejects an unrelated page', () => {
    const page = tokenize('alpha beta gamma delta epsilon zeta eta theta iota kappa');
    assert.ok(locateAnywhere(page, tokenize('gamma delta epsilon zeta eta')).score === 1);
    assert.ok(locateAnywhere(page, tokenize('gamma delta EXTRA epsilon zeta eta')).score >= 0.5);
    assert.equal(locateAnywhere(page, tokenize('nothing here matches at all')).score, 0);
    assert.equal(similarity(['a', 'b'], ['a', 'b']), 1);
});

test('the baseline locates a claim by its named footnote', () => {
    const located = locateBaseline(prepareRevision(BASE), makeTarget(flaggedRow));
    assert.equal(located.method, 'footnote');
    assert.ok(located.score > 0.9);
});

test('an unrelated edit elsewhere is not a change', () => {
    const r = track(flaggedRow, [BASE.replace('was a case.', 'was a United States Supreme Court case.')]);
    assert.equal(r.first, null);
});

test('a bot adding an archive URL to the citation is not a change', () => {
    const r = track(flaggedRow, [BASE.replace('|title=Justices weigh}}', '|title=Justices weigh |archive-url=https://web.archive.org/web/2024/x |access-date=2026-11-06}}')]);
    assert.equal(r.first, null);
});

test('rewording the sentence is sentence_edited, at that revision', () => {
    const r = track(flaggedRow, [
        BASE.replace('was a case.', 'was a Supreme Court case.'),
        BASE.replace('the Court settled a [[circuit split]]', 'the Court resolved a [[circuit split]]'),
    ]);
    assert.deepEqual(r.first.kinds, [CHANGE_KINDS.SENTENCE_EDITED]);
    assert.equal(r.first.meta.rev_id, 102);
    assert.ok(r.first.detail.similarity > 0.8 && r.first.detail.similarity < 1);
});

test('adding {{failed verification}} after the footnote is flag_added', () => {
    const r = track(flaggedRow, [BASE.replace('Justices weigh}}</ref>', 'Justices weigh}}</ref>{{failed verification|date=November 2026}}')]);
    assert.deepEqual(r.first.kinds, [CHANGE_KINDS.FLAG_ADDED]);
    assert.deepEqual(r.first.detail.flags, ['failed verification']);
});

test('removing the footnote but keeping the sentence is footnote_removed', () => {
    const r = track(supportedRow, [BASE.replace(/2023\.<ref>[^<]*<\/ref>/, '2023.')]);
    assert.deepEqual(r.first.kinds, [CHANGE_KINDS.FOOTNOTE_REMOVED]);
});

test('removing sentence and footnote together is sentence_and_footnote_removed', () => {
    const r = track(supportedRow, [BASE.replace(/ Oral arguments[^<]*<ref>[^<]*<\/ref>/, '')]);
    assert.deepEqual(r.first.kinds, [CHANGE_KINDS.SENTENCE_AND_FOOTNOTE_REMOVED]);
});

test('replacing the URL inside a kept named ref is source_replaced', () => {
    const r = track(flaggedRow, [BASE.replace(NYT, 'https://www.reuters.com/legal/some-other-story')]);
    assert.ok(r.first.kinds.includes(CHANGE_KINDS.SOURCE_REPLACED));
});

test('a change that is reverted still counts as the first change; the end state says it was undone', () => {
    const edited = BASE.replace('the Court settled', 'the Court did not settle');
    const r = track(flaggedRow, [edited, BASE]);
    assert.equal(r.first.meta.rev_id, 101);
    assert.deepEqual(r.end.kinds, []);
});

test('revisions whose text is hidden are skipped and counted', () => {
    const r = track(flaggedRow, [null, BASE]);
    assert.equal(r.skipped, 1);
    assert.equal(r.first, null);
});

test('a claim that is nowhere in the baseline is not located, and never "changes"', () => {
    const r = track({ claim_text: 'A sentence that was removed before go-live entirely.', ref_name: '', source_url: '' }, [BASE]);
    assert.equal(r.located, null);
    assert.equal(r.first, null);
});

test('a claim with no identifiable footnote is anchored on the footnote it precedes', () => {
    const text = 'Intro.\n\nThe ship appears in three novels.{{sfn|Smith|2001|p=4}} Next.\n';
    const target = makeTarget({ claim_text: 'The ship appears in three novels.', ref_name: '', source_url: '' });
    const located = locateBaseline(prepareRevision(text), target);
    assert.equal(located.method, 'claim');
    const r = trackSuggestion(target, prepareRevision(text), [
        { meta: meta(101), rev: prepareRevision(text.replace('{{sfn|Smith|2001|p=4}}', '{{sfn|Jones|2010|p=9}}')) },
    ]);
    assert.deepEqual(r.first.kinds, [CHANGE_KINDS.FOOTNOTE_REMOVED]);
});

test('adding a second source next to the footnote is footnote_added; a bot archiving a neighbour is not', () => {
    const added = track(supportedRow, [BASE.replace('dubin-v-united-states/ |title=Docket}}</ref>', 'dubin-v-united-states/ |title=Docket}}</ref><ref>{{cite web|url=https://www.oyez.org/cases/2022/22-10}}</ref>')]);
    assert.deepEqual(added.first.kinds, [CHANGE_KINDS.FOOTNOTE_ADDED]);
    assert.deepEqual(added.first.detail.sources_added, ['url:oyez.org/cases/2022/22-10']);
    const withNeighbour = BASE.replace('dubin-v-united-states/ |title=Docket}}</ref>', 'dubin-v-united-states/ |title=Docket}}</ref><ref>{{cite web|url=https://www.oyez.org/cases/2022/22-10}}</ref>');
    const r = trackSuggestion(makeTarget(supportedRow), prepareRevision(withNeighbour), [{
        meta: meta(101),
        rev: prepareRevision(withNeighbour.replace('22-10}}</ref>', '22-10 |archive-url=https://web.archive.org/web/2026/https://www.oyez.org/cases/2022/22-10 |access-date=2026-11-06}}</ref>')),
    }]);
    assert.equal(r.first, null);
});

test('removing a {{failed verification}} that was there before go-live is flag_removed (the Dubin v. United States fix)', () => {
    const tagged = BASE.replace('Justices weigh}}</ref>', 'Justices weigh}}</ref>{{failed verification|date=May 2024}}');
    const fixed = BASE.replace('Justices weigh}}</ref>', 'Justices weigh}}</ref><ref>{{Cite web |title=Supreme Court Cautions |url=https://www.jdsupra.com/legalnews/x-3547744/ |website=JD Supra}}</ref>');
    const r = trackSuggestion(makeTarget(flaggedRow), prepareRevision(tagged), [{ meta: meta(101), rev: prepareRevision(fixed) }]);
    assert.deepEqual(r.located.flags, ['failed verification']);
    assert.deepEqual(r.first.kinds, [CHANGE_KINDS.FOOTNOTE_ADDED, CHANGE_KINDS.FLAG_REMOVED]);
});

test('a URL swapped inside a neighbouring footnote is source_replaced, not footnote_added (GreenC bot on OpenAI)', () => {
    const two = BASE.replace('dubin-v-united-states/ |title=Docket}}</ref>', 'dubin-v-united-states/ |title=Docket}}</ref><ref>{{cite web|url=https://venturebeat.com/2021/01/05/openai-debuts}}</ref>');
    const moved = two.replace('venturebeat.com/2021/01/05/openai-debuts', 'venturebeat.com/business/openai-debuts');
    const r = trackSuggestion(makeTarget(supportedRow), prepareRevision(two), [{ meta: meta(101), rev: prepareRevision(moved) }]);
    assert.deepEqual(r.first.kinds, [CHANGE_KINDS.SOURCE_REPLACED]);
    const dropped = trackSuggestion(makeTarget(supportedRow), prepareRevision(two), [{ meta: meta(101), rev: prepareRevision(BASE) }]);
    assert.deepEqual(dropped.first.kinds, [CHANGE_KINDS.SOURCE_REMOVED]);
});

test('a URL changed inside a kept named ref is source_replaced (List of fictional ships, ref ":8")', () => {
    const page = 'Intro.\n\n* Musashi – High School Fleet<ref name=":8">{{Cite web |title=Ships |url=http://www.haifuriusa.com/ |access-date=2026-08-22}}</ref>\n* Harekaze – High School Fleet<ref name=":8" />\n';
    const fixed = page.replace('http://www.haifuriusa.com/ |access-date=2026-08-22', 'https://haifuriusa.com/ships/ |access-date=2026-11-04');
    for (const claim of ['Musashi – High School Fleet', 'Harekaze – High School Fleet']) {
        const target = makeTarget({ claim_text: claim, ref_name: ':8', source_url: 'http://www.haifuriusa.com/' });
        const r = trackSuggestion(target, prepareRevision(page), [{ meta: meta(101), rev: prepareRevision(fixed) }]);
        assert.deepEqual(r.first?.kinds, [CHANGE_KINDS.SOURCE_REPLACED], claim);
    }
});
