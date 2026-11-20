import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIEF_PATH, BRIEF_HEADINGS, githubAnchor, briefLink, causeMeaning } from '../feedback-loop/report.js';
import { CAUSE_BRIEF_SECTION, ATTRIBUTION_CAUSES } from '../feedback-loop/adjudicate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every brief link points at a heading the brief still has', () => {
    const headings = readFileSync(join(root, BRIEF_PATH), 'utf8').split('\n')
        .filter(l => l.startsWith('## ')).map(l => l.slice(3).trim());
    for (const section of new Set(Object.values(CAUSE_BRIEF_SECTION).filter(Boolean))) {
        assert.ok(headings.includes(BRIEF_HEADINGS[section]), `cause ${section}: "${BRIEF_HEADINGS[section]}"`);
    }
});

test('anchors follow GitHub\'s rule', () => {
    assert.equal(githubAnchor("1. The model isn't told what the source is"), '1-the-model-isnt-told-what-the-source-is');
    assert.equal(githubAnchor(BRIEF_HEADINGS[2]), '2-unusable-pages-are-judged-as-if-they-were-the-source-and-the-reverse');
    assert.match(briefLink(4), /\/blob\/main\/docs\/design-plans\/2026-11-08-fixable-causes-of-disputed-verdicts\.md#4-omissions-the-editor-cant-check$/);
});

test('every cause has a meaning, written as a sentence', () => {
    for (const cause of Object.values(ATTRIBUTION_CAUSES)) {
        const m = causeMeaning(cause);
        assert.ok(m.length > 10, cause);
        assert.match(m, /^[A-Z]/, cause);
    }
    assert.equal(causeMeaning('(not adjudicated)'), '');
});
