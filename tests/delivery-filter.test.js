import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    hostExcluded, exclusionReason, tierReached, deliveryPredicate, DELIVERY_TIERS, DELIVERY_TIER_NAMES,
} from '../service/delivery-filter.js';
import { csvHeaderLine, findingToCsvLine, parseCsv, cleanCsvText } from '../service/csv-report.js';
import { main as cleanCsvMain, deliverCsvPath } from '../service/clean-csv.js';
import { reviewSweep, deliveryCounts } from '../scripts/review-sweep.js';

const row = over => ({
    verdict: 'NOT SUPPORTED', reason_type: 'contradiction', quote_status: 'exact',
    source_url: 'https://a.ru/x', claim_text: 'Обычное утверждение о событии', ...over,
});

test('problem hosts match as a suffix, not a substring', () => {
    assert.equal(hostExcluded('www.youtube.com'), true);
    assert.equal(hostExcluded('notyoutube.com'), false);
});

test('a row is excluded for its host or for a table-cell claim, judged on its own', () => {
    assert.equal(exclusionReason(row({ verdict: 'SUPPORTED' })), 'not-flagged');
    assert.equal(exclusionReason(row({ source_url: 'https://vk.com/wall-1' })), 'problem-host');
    assert.equal(exclusionReason(row({ claim_text: '12.03.2019 — 1:2' })), 'table-cell');
    assert.equal(exclusionReason(row({})), null);
});

test('tiers are cumulative', () => {
    assert.equal(tierReached(row({ verdict: 'SUPPORTED' })), -1);
    assert.equal(tierReached(row({ source_url: 'https://www.youtube.com/watch?v=1' })), 0);
    assert.equal(tierReached(row({ verdict: 'PARTIALLY SUPPORTED', reason_type: '' })), 1);
    assert.equal(tierReached(row({ reason_type: 'omission' })), 2);
    assert.equal(tierReached(row({ quote_status: 'not-found' })), 3);
    assert.equal(tierReached(row({})), DELIVERY_TIERS.length - 1);
    assert.deepEqual(DELIVERY_TIER_NAMES, ['flagged', 'not-supported', 'contradiction', 'verified-contradiction']);
    assert.throws(() => deliveryPredicate('everything'), /unknown delivery tier/);
});

const base = {
    wiki: 'ruwiki', pageTitle: 'Статья', pageId: 1, revisionId: 2, provider: 'liftwing-safeguard',
    model: 'llm-gpt-oss-safeguard-20b', promptVersion: 'v2', fetchStatus: 200, rationale: 'Обоснование вердикта.',
};

function sweepCsv() {
    const findings = [];
    const variants = [
        { verdict: 'NOT SUPPORTED', reasonType: 'contradiction', quoteStatus: 'exact' },
        { verdict: 'NOT SUPPORTED', reasonType: 'contradiction', quoteStatus: 'not-found' },
        { verdict: 'NOT SUPPORTED', reasonType: 'omission' },
        { verdict: 'PARTIALLY SUPPORTED' },
        { verdict: 'SUPPORTED', quoteStatus: 'exact' },
        { verdict: 'NOT SUPPORTED', reasonType: 'contradiction', quoteStatus: 'exact', sourceUrl: 'https://vk.com/wall-1' },
        { verdict: 'NOT SUPPORTED', reasonType: 'contradiction', quoteStatus: 'exact', claimText: '1:2, 12.03.2019' },
        { verdict: 'NOT SUPPORTED', reasonType: 'omission', sourceTruncated: true },
    ];
    for (let page = 1; page <= 6; page++) {
        variants.forEach((v, i) => findings.push({
            ...base, pageId: page, pageTitle: `Статья ${page}`, citationNumber: String(i),
            claimText: 'Обычное утверждение о событии', sourceUrl: `https://a.ru/${page}/${i}`, ...v,
        }));
    }
    return csvHeaderLine() + findings.map(findingToCsvLine).join('');
}

test('clean-csv --deliver writes exactly the rows review-sweep counts for that tier', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deliver-'));
    const input = join(dir, 'ru-rerun.csv');
    const csv = sweepCsv();
    await writeFile(input, csv);
    const cleanPath = join(dir, 'ru-rerun-clean.csv');
    await writeFile(cleanPath, cleanCsvText(csv));
    const { summary } = await reviewSweep(cleanPath);
    const { totals } = deliveryCounts(summary);

    for (const [i, tier] of DELIVERY_TIERS.entries()) {
        if (i === 0) continue;
        const quiet = { stdout: { write() {} }, stderr: { write() {} } };
        assert.equal(await cleanCsvMain(['node', 'clean-csv.js', input, '--deliver', tier.name], quiet), 0);
        const out = parseCsv(await readFile(deliverCsvPath(input, tier.name), 'utf8'));
        assert.equal(out.length - 1, totals[i], `tier ${tier.name}`);
    }
    // The recommended first delivery: verified contradictions only.
    const delivered = parseCsv(await readFile(deliverCsvPath(input, 'verified-contradiction'), 'utf8'));
    const h = delivered[0];
    for (const r of delivered.slice(1)) {
        assert.equal(r[h.indexOf('verdict')], 'NOT SUPPORTED');
        assert.equal(r[h.indexOf('reason_type')], 'contradiction');
        assert.equal(r[h.indexOf('quote_status')], 'exact');
    }
    assert.equal(delivered.length - 1, 6, 'one per article: the vk.com and table-cell contradictions are out');
});

test('clean-csv rejects an unknown tier', async () => {
    let err = '';
    const code = await cleanCsvMain(['node', 'clean-csv.js', 'x.csv', '--deliver', 'all'], {
        stdout: { write() {} }, stderr: { write: t => { err += t; } },
    });
    assert.equal(code, 2);
    assert.match(err, /unknown delivery tier/);
});
