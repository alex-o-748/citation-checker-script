#!/usr/bin/env node
// Sanity check against Wikimedia's own dashboard (grafana.wikimedia.org,
// board "Edit Check usage", check llmSourceVerification): how many times the
// suggestion was shown and seen, and what editors did with the card.
//
// Uses the dashboard's own counter expression, which adds back the first
// sample of a series that starts inside the range — plain increase() drops
// it, and these counters are sparse enough that it matters.
//
// The datasource answers PromQL anonymously; one request per metric.
//
//   node analysis/grafana-check.js --since 2026-11-05T00:33:00Z

import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export const PROM_URL = 'https://grafana.wikimedia.org/api/datasources/proxy/uid/000000026/api/v1/query';

export function dashboardIncrease(selector, range) {
    return `((increase(${selector}[${range}]) + (min_over_time(${selector}[${range}]) unless ${selector} offset ${range})) or increase(${selector}[${range}]))`;
}

export function queries(kind, range) {
    const shown = `mediawiki_editcheck_actions_total{kind="${kind}", moment=~"presave|midedit"}`;
    const acted = `mediawiki_editcheck_actionsTaken_total{kind="${kind}", moment=~"presave|midedit"}`;
    return {
        events: `sum by (wiki, event) (${dashboardIncrease(shown, range)})`,
        actions: `sum by (wiki, act) (${dashboardIncrease(acted, range)})`,
    };
}

export async function runCheck({ since, until = new Date(), kind = 'llmSourceVerification', fetchImpl = fetch }) {
    const seconds = Math.max(60, Math.round((until.getTime() - Date.parse(since)) / 1000));
    const range = `${seconds}s`;
    const out = {};
    for (const [name, query] of Object.entries(queries(kind, range))) {
        const url = `${PROM_URL}?${new URLSearchParams({ query, time: String(until.getTime() / 1000) })}`;
        const response = await fetchImpl(url, { headers: { 'User-Agent': 'citation-checker-script-edit-impact/0.1 (https://github.com/alex-o-748/citation-checker-script)' } });
        if (!response.ok) throw new Error(`Prometheus: HTTP ${response.status}`);
        const body = await response.json();
        out[name] = (body.data?.result ?? []).map(r => ({ ...r.metric, value: Math.round(Number(r.value[1])) }));
    }
    return { since, until: until.toISOString(), kind, ...out };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const { values } = parseArgs({ options: { since: { type: 'string', default: '2026-11-05T00:33:00Z' }, until: { type: 'string' }, kind: { type: 'string', default: 'llmSourceVerification' } } });
    const result = await runCheck({ since: values.since, until: values.until ? new Date(values.until) : new Date(), kind: values.kind });
    console.log(`${result.kind}, ${result.since} → ${result.until}`);
    for (const r of result.events.sort((a, b) => `${a.wiki}${a.event}`.localeCompare(`${b.wiki}${b.event}`))) console.log(`  ${r.wiki}  ${r.event.padEnd(8)} ${r.value}`);
    for (const r of result.actions.sort((a, b) => `${a.wiki}${a.act}`.localeCompare(`${b.wiki}${b.act}`))) console.log(`  ${r.wiki}  action:${r.act.padEnd(8)} ${r.value}`);
}
