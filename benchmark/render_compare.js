/**
 * Escape HTML-significant characters: & < > " '
 * Returns empty string for null/undefined.
 */
export function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

/**
 * Background color for an accuracy delta given a noise floor (in pp).
 * Green if delta >= +floor, red if delta <= -floor, grey otherwise.
 */
export function deltaColor(delta, noiseFloor = 5) {
    if (delta >= noiseFloor) return '#e6ffe6';
    if (delta <= -noiseFloor) return '#ffe6e6';
    return '#f0f0f0';
}

/**
 * Background color for a flip direction.
 */
export function directionColor(direction) {
    switch (direction) {
        case 'improvement': return '#e6ffe6';
        case 'regression':  return '#ffe6e6';
        case 'lateral':     return '#fff5cc';
        default:            return '#ffffff';
    }
}

/**
 * Serialize a ComparisonResult to pretty-printed JSON.
 * The `perProvider` Map is converted to a plain object.
 * The `cells` array drops the back-reference to `datasetEntry` to avoid
 * duplicating dataset content into the report.
 *
 * @param {ReturnType<import('./compare_results.js').compareResults>} result
 * @param {{indent?: number}} [options]
 */
export function renderJson(result, options = {}) {
    const indent = options.indent ?? 2;
    const serializable = {
        metadata: result.metadata,
        coverage: result.coverage,
        perProvider: Object.fromEntries(result.perProvider),
        cells: result.cells.map(({ datasetEntry, ...rest }) => rest),
        flips: result.flips.map(({ datasetEntry, ...rest }) => rest),
    };
    return JSON.stringify(serializable, null, indent);
}

function fmtPct(n) {
    return `${n.toFixed(1)}%`;
}
function fmtDelta(n) {
    const sign = n >= 0 ? '+' : '';
    return `${sign}${n.toFixed(1)}`;
}

/**
 * Render a ComparisonResult as a Markdown report.
 * Sections: header (metadata + coverage), headline accuracy table, flip table.
 *
 * @param {ReturnType<import('./compare_results.js').compareResults>} result
 * @param {{noiseFloor?: number}} [options]
 */
export function renderMarkdown(result, options = {}) {
    const noiseFloor = options.noiseFloor ?? 5;
    const lines = [];
    lines.push(`# Compare Results — ${result.metadata.generatedAt}`);
    lines.push('');
    if (result.metadata.changeAxes && result.metadata.changeAxes.length > 0) {
        const axes = result.metadata.changeAxes.map(a => `\`${a}\``).join(', ');
        lines.push(`Change axes: ${axes}`);
    }
    if (result.metadata.groundTruthVersion) {
        lines.push(`Ground truth version: \`${result.metadata.groundTruthVersion}\``);
    }
    if (result.metadata.controlRunAt) {
        lines.push(`Control run at: ${result.metadata.controlRunAt}`);
    }
    if (result.metadata.treatmentRunAt) {
        lines.push(`Treatment run at: ${result.metadata.treatmentRunAt}`);
    }
    lines.push('');
    lines.push(`Compared cells: **${result.coverage.comparedCells}** of ${result.coverage.intersectionCells} intersection (${result.coverage.controlOnlyCells} control-only, ${result.coverage.treatmentOnlyCells} treatment-only excluded). Dataset: ${result.coverage.datasetValid} valid of ${result.coverage.datasetTotal}.`);
    lines.push(`Noise floor: ±${noiseFloor}pp (single-provider 95% CI heuristic).`);
    lines.push('');

    lines.push('## Headline accuracy');
    lines.push('');
    lines.push('| Provider | n | Control exact | Treatment exact | Δ exact | Control lenient | Treatment lenient | Δ lenient | Control binary | Treatment binary | Δ binary |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const [provider, stats] of result.perProvider) {
        const flag = (Math.abs(stats.exact.delta) < noiseFloor
                   && Math.abs(stats.lenient.delta) < noiseFloor
                   && Math.abs(stats.binary.delta) < noiseFloor)
            ? ' (noise)'
            : '';
        lines.push(
            `| ${provider}${flag} | ${stats.n} | ${fmtPct(stats.exact.controlPct)} | ${fmtPct(stats.exact.treatmentPct)} | ${fmtDelta(stats.exact.delta)} | ${fmtPct(stats.lenient.controlPct)} | ${fmtPct(stats.lenient.treatmentPct)} | ${fmtDelta(stats.lenient.delta)} | ${fmtPct(stats.binary.controlPct)} | ${fmtPct(stats.binary.treatmentPct)} | ${fmtDelta(stats.binary.delta)} |`
        );
    }
    lines.push('');

    lines.push('## Flips');
    lines.push('');
    if (result.flips.length === 0) {
        lines.push('_No flips — every cell either stayed correct or stayed wrong with the same verdict._');
    } else {
        lines.push('| Provider | Entry ID | Claim | Control | Treatment | Ground truth | Direction |');
        lines.push('|---|---|---|---|---|---|---|');
        for (const flip of result.flips) {
            const claim = flip.claimText.length > 60 ? flip.claimText.slice(0, 60) + '…' : flip.claimText;
            lines.push(
                `| ${flip.provider} | ${flip.entryId} | ${claim.replace(/\|/g, '\\|')} | ${flip.controlVerdict} | ${flip.treatmentVerdict} | ${flip.groundTruth} | ${flip.direction} |`
            );
        }
    }
    lines.push('');

    return lines.join('\n');
}

/**
 * Render a ComparisonResult as a self-contained HTML document.
 * Includes inline CSS, a metadata header, a headline-accuracy table with
 * color-coded delta cells, and a flip table with color-coded direction cells.
 *
 * @param {ReturnType<import('./compare_results.js').compareResults>} result
 * @param {{noiseFloor?: number, title?: string}} [options]
 */
export function renderHtml(result, options = {}) {
    const noiseFloor = options.noiseFloor ?? 5;
    const title = options.title ?? 'Compare Results';

    const headerRows = [];
    if (result.metadata.changeAxes && result.metadata.changeAxes.length > 0) {
        headerRows.push(`<p><span class="metadata-key">Change axes:</span> ${escapeHtml(result.metadata.changeAxes.join(', '))}</p>`);
    }
    if (result.metadata.groundTruthVersion) {
        headerRows.push(`<p><span class="metadata-key">Ground truth version:</span> ${escapeHtml(result.metadata.groundTruthVersion)}</p>`);
    }
    if (result.metadata.controlRunAt) {
        headerRows.push(`<p><span class="metadata-key">Control run at:</span> ${escapeHtml(result.metadata.controlRunAt)}</p>`);
    }
    if (result.metadata.treatmentRunAt) {
        headerRows.push(`<p><span class="metadata-key">Treatment run at:</span> ${escapeHtml(result.metadata.treatmentRunAt)}</p>`);
    }
    headerRows.push(`<p><span class="metadata-key">Compared cells:</span> ${result.coverage.comparedCells} of ${result.coverage.intersectionCells} intersection</p>`);
    headerRows.push(`<p><span class="metadata-key">Dataset:</span> ${result.coverage.datasetValid} valid of ${result.coverage.datasetTotal}</p>`);
    headerRows.push(`<p><span class="metadata-key">Noise floor:</span> ±${noiseFloor}pp</p>`);
    headerRows.push(`<p><span class="metadata-key">Generated:</span> ${escapeHtml(result.metadata.generatedAt)}</p>`);

    const headlineRows = [];
    for (const [provider, stats] of result.perProvider) {
        headlineRows.push(`        <tr>
          <td>${escapeHtml(provider)}</td>
          <td class="num">${stats.n}</td>
          <td class="num">${stats.exact.control}/${stats.n} (${stats.exact.controlPct.toFixed(1)}%)</td>
          <td class="num">${stats.exact.treatment}/${stats.n} (${stats.exact.treatmentPct.toFixed(1)}%)</td>
          <td class="num delta" style="background-color: ${deltaColor(stats.exact.delta, noiseFloor)};">${stats.exact.delta >= 0 ? '+' : ''}${stats.exact.delta.toFixed(1)}</td>
          <td class="num">${stats.lenient.control}/${stats.n} (${stats.lenient.controlPct.toFixed(1)}%)</td>
          <td class="num">${stats.lenient.treatment}/${stats.n} (${stats.lenient.treatmentPct.toFixed(1)}%)</td>
          <td class="num delta" style="background-color: ${deltaColor(stats.lenient.delta, noiseFloor)};">${stats.lenient.delta >= 0 ? '+' : ''}${stats.lenient.delta.toFixed(1)}</td>
          <td class="num">${stats.binary.control}/${stats.n} (${stats.binary.controlPct.toFixed(1)}%)</td>
          <td class="num">${stats.binary.treatment}/${stats.n} (${stats.binary.treatmentPct.toFixed(1)}%)</td>
          <td class="num delta" style="background-color: ${deltaColor(stats.binary.delta, noiseFloor)};">${stats.binary.delta >= 0 ? '+' : ''}${stats.binary.delta.toFixed(1)}</td>
        </tr>`);
    }

    const flipRows = [];
    for (const flip of result.flips) {
        const claim = flip.claimText.length > 80 ? flip.claimText.slice(0, 80) + '…' : flip.claimText;
        flipRows.push(`        <tr style="background-color: ${directionColor(flip.direction)};">
          <td>${escapeHtml(flip.provider)}</td>
          <td>${escapeHtml(flip.entryId)}</td>
          <td><a href="${escapeHtml(flip.sourceUrl)}" target="_blank" rel="noopener" title="${escapeHtml(flip.claimText)}">${escapeHtml(claim)}</a></td>
          <td>${escapeHtml(flip.controlVerdict)}</td>
          <td>${escapeHtml(flip.treatmentVerdict)}</td>
          <td>${escapeHtml(flip.groundTruth)}</td>
          <td><strong>${escapeHtml(flip.direction)}</strong></td>
        </tr>`);
    }
    if (flipRows.length === 0) {
        flipRows.push(`        <tr><td colspan="7"><em>No flips — every cell either stayed correct or stayed wrong with the same verdict.</em></td></tr>`);
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 20px; line-height: 1.6; color: #333; }
    h1, h2 { color: #222; }
    h1 { border-bottom: 2px solid #ccc; padding-bottom: 10px; }
    .header-section { background: #f9f9f9; padding: 15px; border-radius: 4px; margin-bottom: 30px; }
    .header-section p { margin: 5px 0; }
    .metadata-key { font-weight: bold; display: inline-block; width: 180px; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 30px; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th, td { border: 1px solid #ddd; padding: 10px; text-align: left; }
    th { background: #f0f0f0; font-weight: 600; }
    tr:nth-child(even) { background: #fafafa; }
    .num { text-align: right; }
    .delta { font-weight: 600; text-align: center; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="header-section">
${headerRows.join('\n')}
  </div>
  <h2>Headline accuracy</h2>
  <table>
    <thead>
      <tr>
        <th>Provider</th><th>n</th>
        <th>Control exact</th><th>Treatment exact</th><th>Δ exact</th>
        <th>Control lenient</th><th>Treatment lenient</th><th>Δ lenient</th>
        <th>Control binary</th><th>Treatment binary</th><th>Δ binary</th>
      </tr>
    </thead>
    <tbody>
${headlineRows.join('\n')}
    </tbody>
  </table>
  <p style="font-size: 0.9em; color: #666;">Green = Δ ≥ +${noiseFloor}pp · Red = Δ ≤ -${noiseFloor}pp · Grey = within ±${noiseFloor}pp noise floor.</p>
  <h2>Flips</h2>
  <table>
    <thead>
      <tr>
        <th>Provider</th><th>Entry ID</th><th>Claim</th>
        <th>Control</th><th>Treatment</th><th>Ground truth</th><th>Direction</th>
      </tr>
    </thead>
    <tbody>
${flipRows.join('\n')}
    </tbody>
  </table>
  <p style="font-size: 0.9em; color: #666;">
    <span style="background: #e6ffe6; padding: 2px 4px;">green = improvement</span> ·
    <span style="background: #ffe6e6; padding: 2px 4px;">red = regression</span> ·
    <span style="background: #fff5cc; padding: 2px 4px;">yellow = lateral</span>.
  </p>
</body>
</html>
`;
}
