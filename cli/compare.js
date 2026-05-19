import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { UsageError } from './verify.js';
import { compareResults, filterComparison } from '../benchmark/compare_results.js';
import { renderJson, renderMarkdown, renderHtml } from '../benchmark/render_compare.js';

export const COMPARE_HELP_TEXT = `usage: ccs compare <control.json> <treatment.json> --dataset <dataset.json> [options]

Compare two benchmark results.json files and produce a per-provider accuracy
+ flip report. Always exits 0 on success — inspect the report for regressions
rather than relying on exit codes.

Arguments:
  <control.json>     Baseline results.json (treated as the "before" run).
  <treatment.json>   Comparison results.json (treated as the "after" run).

Required:
  --dataset <path>   Path to the dataset.json that produced both runs.
                     Used for ground_truth, claim_text, and source_url.

Options:
  --report <path>    Write the report to this path. Format is chosen by
                     extension: .html, .md / .markdown, or .json. If omitted,
                     JSON is written to stdout.
  --filter <expr>    Post-hoc subset filter. Supported expressions:
                       version=<v1|v2|v3|...>   filter by dataset_version
                       provider=<name>          filter to a single provider
                       direction=<improvement|regression|lateral|unchanged-correct|unchanged-wrong-same>  filter by direction class
  --noise-floor <pp> Annotate per-provider rows whose |Δ| is below this
                     threshold (in percentage points). Default: 5.
  --change-axis <a>  What differs between control and treatment (e.g.,
                     "prompt", "source_text"). Repeat for multiple axes.
                     Recorded in report metadata.
  --gt-version <s>   Ground-truth version label (e.g.,
                     "post-audit-2026-04-30"). Recorded in report metadata.
  --help, -h         Show this help and exit.

Examples:
  ccs compare control.json treatment.json --dataset dataset.json
  ccs compare control.json treatment.json --dataset dataset.json --report report.html
  ccs compare control.json treatment.json --dataset dataset.json --report out.md --filter version=v2
`;

export function parseCompareArgs(args) {
    if (args.includes('-h') || args.includes('--help')) {
        return { help: true, scope: 'compare' };
    }

    const { values, positionals } = parseArgs({
        args,
        options: {
            dataset:        { type: 'string' },
            report:         { type: 'string' },
            filter:         { type: 'string' },
            'noise-floor':  { type: 'string', default: '5' },
            'change-axis':  { type: 'string', multiple: true },
            'gt-version':   { type: 'string' },
            help:           { type: 'boolean', short: 'h', default: false },
        },
        allowPositionals: true,
        strict: true,
    });

    const [controlPath, treatmentPath] = positionals;
    if (!controlPath || !treatmentPath) {
        throw new UsageError('usage: ccs compare <control.json> <treatment.json> --dataset <dataset.json>');
    }
    if (!values.dataset) {
        throw new UsageError('--dataset <path-to-dataset.json> is required');
    }
    const noiseFloor = parseFloat(values['noise-floor']);
    if (!Number.isFinite(noiseFloor) || noiseFloor < 0) {
        throw new UsageError(`--noise-floor must be a non-negative number (got: ${values['noise-floor']})`);
    }

    return {
        help: false,
        controlPath,
        treatmentPath,
        datasetPath: values.dataset,
        reportPath: values.report ?? null,
        filter: values.filter ?? null,
        noiseFloor,
        changeAxes: values['change-axis'] ?? [],
        groundTruthVersion: values['gt-version'] ?? null,
    };
}

function parseFilterExpression(expr) {
    const eq = expr.indexOf('=');
    if (eq === -1) {
        throw new UsageError(`bad --filter syntax (expected key=value): ${expr}`);
    }
    const key = expr.slice(0, eq);
    const value = expr.slice(eq + 1);
    if (key === 'version') {
        return ({ datasetEntry }) => datasetEntry.dataset_version === value;
    }
    if (key === 'provider') {
        return ({ provider }) => provider === value;
    }
    if (key === 'direction') {
        const VALID = ['improvement', 'regression', 'lateral', 'unchanged-correct', 'unchanged-wrong-same'];
        if (!VALID.includes(value)) {
            throw new UsageError(`unknown direction: ${value} (supported: ${VALID.join(', ')})`);
        }
        return ({ direction }) => direction === value;
    }
    throw new UsageError(`unknown --filter key: ${key} (supported: version, provider, direction)`);
}

function chooseRenderer(reportPath) {
    const lower = reportPath.toLowerCase();
    if (lower.endsWith('.html'))     return renderHtml;
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
        return renderMarkdown;
    }
    if (lower.endsWith('.json'))     return renderJson;
    return null;
}

export async function runCompare(opts, { stdout = process.stdout, stderr = process.stderr } = {}) {
    let control, treatment, dataset;
    try {
        control = JSON.parse(fs.readFileSync(opts.controlPath, 'utf8'));
    } catch (err) {
        stderr.write(`ccs compare: failed to read control (${opts.controlPath}): ${err.message}\n`);
        return 2;
    }
    try {
        treatment = JSON.parse(fs.readFileSync(opts.treatmentPath, 'utf8'));
    } catch (err) {
        stderr.write(`ccs compare: failed to read treatment (${opts.treatmentPath}): ${err.message}\n`);
        return 2;
    }
    try {
        const datasetRaw = JSON.parse(fs.readFileSync(opts.datasetPath, 'utf8'));
        dataset = Array.isArray(datasetRaw) ? datasetRaw : (datasetRaw.rows ?? []);
    } catch (err) {
        stderr.write(`ccs compare: failed to read dataset (${opts.datasetPath}): ${err.message}\n`);
        return 2;
    }

    let result = compareResults({
        control, treatment, dataset,
        options: {
            changeAxes: opts.changeAxes,
            groundTruthVersion: opts.groundTruthVersion,
        },
    });

    if (opts.filter) {
        let predicate;
        try {
            predicate = parseFilterExpression(opts.filter);
        } catch (err) {
            stderr.write(`ccs compare: ${err.message}\n`);
            return 2;
        }
        result = filterComparison(result, predicate);
    }

    if (result.coverage.comparedCells === 0) {
        stderr.write(`ccs compare: no cells in intersection — control and treatment share no successful (entry_id, provider) pairs (or all pairs were filtered out).\n`);
        return 2;
    }

    if (!opts.reportPath) {
        stdout.write(renderJson(result, { indent: 2 }));
        stdout.write('\n');
        return 0;
    }

    const render = chooseRenderer(opts.reportPath);
    if (!render) {
        stderr.write(`ccs compare: unrecognized report extension (use .html, .md, or .json): ${opts.reportPath}\n`);
        return 2;
    }
    const rendered = render(result, { noiseFloor: opts.noiseFloor });
    fs.writeFileSync(opts.reportPath, rendered, 'utf8');
    stdout.write(`Report written to ${opts.reportPath} (${result.coverage.comparedCells} cells compared)\n`);
    return 0;
}
