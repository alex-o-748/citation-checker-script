import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVoteRows, PANEL, PANEL_FULL, PANEL_FAST, PANEL_HF } from '../benchmark/compute_ensemble.js';

// Helper: build a row matching the shape produced by run_benchmark.js.
function row(entry_id, provider, predicted_verdict, ground_truth, opts = {}) {
    return {
        entry_id,
        provider,
        model: provider.replace('openrouter-', ''),
        ground_truth,
        predicted_verdict,
        confidence: 90,
        comments: '',
        latency_ms: opts.latency_ms ?? 1000,
        cost_usd: opts.cost_usd ?? 0.0001,
        prompt_tokens: 100,
        completion_tokens: 50,
        error: null,
        correct: predicted_verdict === ground_truth ? 'exact' : 'wrong',
        timestamp: '2026-05-02T00:00:00Z'
    };
}

// Build a complete 5-voter input for one entry.
function panelRows(entry_id, ground_truth, verdicts, costs = []) {
    return PANEL.map((p, i) => row(entry_id, p, verdicts[i], ground_truth, {
        cost_usd: costs[i] ?? 0.0001
    }));
}

test('buildVoteRows synthesizes one vote-5 and one vote-5-binary row per complete entry', () => {
    const input = panelRows('row_1', 'Supported',
        ['Supported', 'Supported', 'Supported', 'Supported', 'Not supported']);
    const synth = buildVoteRows(input, PANEL);
    assert.equal(synth.length, 2);
    const providers = synth.map(r => r.provider).sort();
    assert.deepEqual(providers, ['openrouter-vote-5', 'openrouter-vote-5-binary']);
});

test('buildVoteRows skips entries where a panel member is missing', () => {
    const input = panelRows('row_1', 'Supported',
        ['Supported', 'Supported', 'Supported', 'Supported', 'Not supported'])
        .slice(0, 4); // drop the qwen-3-32b row
    const synth = buildVoteRows(input, PANEL);
    assert.equal(synth.length, 0);
});

test('buildVoteRows vote-5 4-class picks plurality verdict', () => {
    const input = panelRows('row_1', 'Supported',
        ['Supported', 'Supported', 'Supported', 'Partially supported', 'Not supported']);
    const synth = buildVoteRows(input, PANEL);
    const vote5 = synth.find(r => r.provider === 'openrouter-vote-5');
    assert.equal(vote5.predicted_verdict, 'Supported');
    assert.equal(vote5.correct, 'exact');
});

test('buildVoteRows vote-5 4-class applies tiebreaker on 2-2-1 ties', () => {
    // 2 Supported, 2 Partially, 1 Not — tie between Supported and Partially at count=2.
    // Skeptical rank: Partially > Supported, so Partially wins.
    const input = panelRows('row_1', 'Partially supported',
        ['Supported', 'Supported', 'Partially supported', 'Partially supported', 'Not supported']);
    const synth = buildVoteRows(input, PANEL);
    const vote5 = synth.find(r => r.provider === 'openrouter-vote-5');
    assert.equal(vote5.predicted_verdict, 'Partially supported');
});

test('buildVoteRows vote-5-binary collapses Partially supported into support class', () => {
    // 2 Supported + 1 Partially = 3 in support class; 2 Not supported.
    // 3-of-5 majority → support class wins, surfaced as "Supported".
    const input = panelRows('row_1', 'Supported',
        ['Supported', 'Supported', 'Partially supported', 'Not supported', 'Not supported']);
    const synth = buildVoteRows(input, PANEL);
    const binary = synth.find(r => r.provider === 'openrouter-vote-5-binary');
    assert.equal(binary.predicted_verdict, 'Supported');
});

test('buildVoteRows vote-5-binary returns Not supported when sub-majority in support class', () => {
    // 2 in support class, 3 in not-support class.
    const input = panelRows('row_1', 'Not supported',
        ['Supported', 'Partially supported', 'Not supported', 'Not supported', 'Source unavailable']);
    const synth = buildVoteRows(input, PANEL);
    const binary = synth.find(r => r.provider === 'openrouter-vote-5-binary');
    assert.equal(binary.predicted_verdict, 'Not supported');
});

test('buildVoteRows synthetic row carries ground_truth from input rows', () => {
    const input = panelRows('row_1', 'Partially supported',
        ['Supported', 'Supported', 'Partially supported', 'Partially supported', 'Not supported']);
    const synth = buildVoteRows(input, PANEL);
    for (const r of synth) {
        assert.equal(r.ground_truth, 'Partially supported');
        assert.equal(r.entry_id, 'row_1');
    }
});

test('buildVoteRows synthetic row cost_usd equals sum of panel costs', () => {
    const input = panelRows('row_1', 'Supported',
        ['Supported', 'Supported', 'Supported', 'Supported', 'Supported'],
        [0.0001, 0.0002, 0.0003, 0.0004, 0.0005]);
    const synth = buildVoteRows(input, PANEL);
    const vote5 = synth.find(r => r.provider === 'openrouter-vote-5');
    assert.equal(vote5.cost_usd, 0.0015);
});

test('buildVoteRows correct field is computed against the synthesized verdict', () => {
    // Vote-5 picks Supported (4 votes); ground truth Not supported → wrong.
    const input = panelRows('row_1', 'Not supported',
        ['Supported', 'Supported', 'Supported', 'Supported', 'Not supported']);
    const synth = buildVoteRows(input, PANEL);
    const vote5 = synth.find(r => r.provider === 'openrouter-vote-5');
    assert.equal(vote5.predicted_verdict, 'Supported');
    assert.equal(vote5.correct, 'wrong');
});

test('buildVoteRows ignores prior synthesized rows in its input', () => {
    const realRows = panelRows('row_1', 'Supported',
        ['Supported', 'Supported', 'Supported', 'Supported', 'Supported']);
    const priorVote = row('row_1', 'openrouter-vote-5', 'Not supported', 'Supported');
    const priorBinary = row('row_1', 'openrouter-vote-5-binary', 'Not supported', 'Supported');
    const input = [...realRows, priorVote, priorBinary];
    const synth = buildVoteRows(input, PANEL);
    // Should produce exactly one vote-5 + one vote-5-binary, both reflecting the real-rows consensus.
    assert.equal(synth.length, 2);
    const vote5 = synth.find(r => r.provider === 'openrouter-vote-5');
    assert.equal(vote5.predicted_verdict, 'Supported');
});

test('buildVoteRows handles multiple entries independently', () => {
    const input = [
        ...panelRows('row_1', 'Supported',
            ['Supported', 'Supported', 'Supported', 'Supported', 'Supported']),
        ...panelRows('row_2', 'Not supported',
            ['Not supported', 'Not supported', 'Not supported', 'Not supported', 'Not supported'])
    ];
    const synth = buildVoteRows(input, PANEL);
    assert.equal(synth.length, 4); // 2 vote-5 + 2 vote-5-binary
    const row1Vote = synth.find(r => r.entry_id === 'row_1' && r.provider === 'openrouter-vote-5');
    const row2Vote = synth.find(r => r.entry_id === 'row_2' && r.provider === 'openrouter-vote-5');
    assert.equal(row1Vote.predicted_verdict, 'Supported');
    assert.equal(row2Vote.predicted_verdict, 'Not supported');
});

test('PANEL constant matches the chosen 5-model panel', () => {
    assert.deepEqual(PANEL.sort(), [
        'openrouter-gemma-4-26b-a4b',
        'openrouter-granite-4.1-8b',
        'openrouter-mistral-small-3.2',
        'openrouter-nemotron-nano-9b-v2',
        'openrouter-qwen-3-32b'
    ]);
});

test('PANEL re-exports PANEL_FULL for backward compatibility', () => {
    assert.deepEqual([...PANEL].sort(), [...PANEL_FULL].sort());
});

// PANEL_FAST drops Qwen-3-32b (~9s/call) and Nemotron-Nano-9B-v2 (the
// reasoning-capable member; even with reasoning disabled it carries
// per-call overhead). The remaining three — Mistral, Granite, Gemma —
// stay near the panel-leader band on accuracy and run sub-3.5s each, so
// the fast set finishes whole-dataset sweeps in roughly 1/3 of the
// full-panel time. Used for smoketesting prompt or pipeline changes
// without paying the full-panel latency.

test('PANEL_FAST is a 3-member panel (Mistral, Granite, Gemma)', () => {
    assert.equal(PANEL_FAST.length, 3);
    assert.deepEqual([...PANEL_FAST].sort(), [
        'openrouter-gemma-4-26b-a4b',
        'openrouter-granite-4.1-8b',
        'openrouter-mistral-small-3.2'
    ]);
});

test('PANEL_FAST excludes the slow/weakest panel members', () => {
    assert.ok(!PANEL_FAST.includes('openrouter-qwen-3-32b'),
        'Qwen-3-32b is the slowest panel member, must be excluded from fast set');
    assert.ok(!PANEL_FAST.includes('openrouter-nemotron-nano-9b-v2'),
        'Nemotron-Nano-9B-v2 carries reasoning-model overhead, must be excluded from fast set');
});

function fastPanelRows(entry_id, ground_truth, verdicts, costs = []) {
    return PANEL_FAST.map((p, i) => row(entry_id, p, verdicts[i], ground_truth, {
        cost_usd: costs[i] ?? 0.0001
    }));
}

test('buildVoteRows with PANEL_FAST synthesizes openrouter-vote-3 + openrouter-vote-3-binary', () => {
    const input = fastPanelRows('row_1', 'Supported',
        ['Supported', 'Supported', 'Not supported']);
    const synth = buildVoteRows(input, PANEL_FAST);
    assert.equal(synth.length, 2);
    const providers = synth.map(r => r.provider).sort();
    assert.deepEqual(providers, ['openrouter-vote-3', 'openrouter-vote-3-binary']);
});

test('buildVoteRows with PANEL_FAST picks plurality on 2-1 split', () => {
    const input = fastPanelRows('row_1', 'Supported',
        ['Supported', 'Supported', 'Not supported']);
    const synth = buildVoteRows(input, PANEL_FAST);
    const v3 = synth.find(r => r.provider === 'openrouter-vote-3');
    assert.equal(v3.predicted_verdict, 'Supported');
});

test('buildVoteRows with PANEL_FAST applies skeptical tiebreaker on 1-1-1 ties', () => {
    // Three different verdicts, all tied at count=1. Skeptical rank picks
    // Partially > Not > Supported, so Partially wins.
    const input = fastPanelRows('row_1', 'Partially supported',
        ['Supported', 'Partially supported', 'Not supported']);
    const synth = buildVoteRows(input, PANEL_FAST);
    const v3 = synth.find(r => r.provider === 'openrouter-vote-3');
    assert.equal(v3.predicted_verdict, 'Partially supported');
});

test('buildVoteRows with PANEL_FAST binary returns Supported on 2-of-3 support class', () => {
    const input = fastPanelRows('row_1', 'Supported',
        ['Supported', 'Partially supported', 'Not supported']);
    const synth = buildVoteRows(input, PANEL_FAST);
    const binary = synth.find(r => r.provider === 'openrouter-vote-3-binary');
    assert.equal(binary.predicted_verdict, 'Supported');
});

test('buildVoteRows with PANEL_FAST binary returns Not supported on 1-of-3 support class', () => {
    const input = fastPanelRows('row_1', 'Not supported',
        ['Supported', 'Not supported', 'Source unavailable']);
    const synth = buildVoteRows(input, PANEL_FAST);
    const binary = synth.find(r => r.provider === 'openrouter-vote-3-binary');
    assert.equal(binary.predicted_verdict, 'Not supported');
});

test('buildVoteRows skips entries where any PANEL_FAST member is missing', () => {
    const input = fastPanelRows('row_1', 'Supported',
        ['Supported', 'Supported', 'Not supported']).slice(0, 2);
    const synth = buildVoteRows(input, PANEL_FAST);
    assert.equal(synth.length, 0);
});

test('buildVoteRows strip filter removes prior vote-3 AND vote-5 synthesized rows', () => {
    // Mix fast-panel rows with stale vote-3 + vote-5 + vote-5-binary leftovers
    // from a prior run. buildVoteRows(PANEL_FAST) should ignore all four
    // synthesized providers when reading input (otherwise stale-rebuilt rows
    // would feed back into a future panel computation).
    const fastRows = fastPanelRows('row_1', 'Supported',
        ['Supported', 'Supported', 'Supported']);
    const stale = [
        row('row_1', 'openrouter-vote-3', 'Not supported', 'Supported'),
        row('row_1', 'openrouter-vote-3-binary', 'Not supported', 'Supported'),
        row('row_1', 'openrouter-vote-5', 'Not supported', 'Supported'),
        row('row_1', 'openrouter-vote-5-binary', 'Not supported', 'Supported')
    ];
    const input = [...fastRows, ...stale];
    const synth = buildVoteRows(input, PANEL_FAST);
    assert.equal(synth.length, 2);
    const v3 = synth.find(r => r.provider === 'openrouter-vote-3');
    assert.equal(v3.predicted_verdict, 'Supported');
});

test('buildVoteRows synthesized vote-3 sums cost across just the 3 fast-panel members', () => {
    const input = fastPanelRows('row_1', 'Supported',
        ['Supported', 'Supported', 'Supported'],
        [0.0001, 0.0002, 0.0003]);
    const synth = buildVoteRows(input, PANEL_FAST);
    const v3 = synth.find(r => r.provider === 'openrouter-vote-3');
    // Float-precision: 0.0001 + 0.0002 + 0.0003 = 0.6e-3 in math but ~6.000…01e-4 in IEEE-754.
    assert.ok(Math.abs(v3.cost_usd - 0.0006) < 1e-9,
        `expected cost_usd ~0.0006, got ${v3.cost_usd}`);
});

// PANEL_HF — three Hugging Face Inference Provider models. Synthesized
// rows must carry the `hf-` prefix, not `openrouter-`, so analyze_results
// reports the HF panel separately.

// Build PANEL_HF rows, post-processing to drop cost_usd entirely so the
// row matches what callHuggingFace produces (HF Inference Providers does
// not return per-call cost — only token counts).
function hfPanelRows(entry_id, ground_truth, verdicts) {
    return PANEL_HF.map((p, i) => {
        const r = row(entry_id, p, verdicts[i], ground_truth);
        r.cost_usd = null;
        return r;
    });
}

test('PANEL_HF is a 3-member panel (Qwen3-32B, gpt-oss-20b, DeepSeek-V3)', () => {
    assert.equal(PANEL_HF.length, 3);
    assert.deepEqual([...PANEL_HF].sort(), [
        'hf-deepseek-v3',
        'hf-gpt-oss-20b',
        'hf-qwen3-32b'
    ]);
});

test('buildVoteRows with PANEL_HF synthesizes hf-vote-3 + hf-vote-3-binary', () => {
    const input = hfPanelRows('row_1', 'Supported',
        ['Supported', 'Supported', 'Not supported']);
    const synth = buildVoteRows(input, PANEL_HF);
    assert.equal(synth.length, 2);
    const providers = synth.map(r => r.provider).sort();
    assert.deepEqual(providers, ['hf-vote-3', 'hf-vote-3-binary']);
});

test('buildVoteRows with PANEL_HF picks plurality on 2-1 split', () => {
    const input = hfPanelRows('row_1', 'Supported',
        ['Supported', 'Supported', 'Not supported']);
    const synth = buildVoteRows(input, PANEL_HF);
    const v3 = synth.find(r => r.provider === 'hf-vote-3');
    assert.equal(v3.predicted_verdict, 'Supported');
});

test('buildVoteRows with PANEL_HF binary returns Supported on 2-of-3 support class', () => {
    const input = hfPanelRows('row_1', 'Supported',
        ['Supported', 'Partially supported', 'Not supported']);
    const synth = buildVoteRows(input, PANEL_HF);
    const binary = synth.find(r => r.provider === 'hf-vote-3-binary');
    assert.equal(binary.predicted_verdict, 'Supported');
});

test('buildVoteRows with PANEL_HF skips entries where any HF panel member is missing', () => {
    const input = hfPanelRows('row_1', 'Supported',
        ['Supported', 'Supported', 'Not supported']).slice(0, 2);
    const synth = buildVoteRows(input, PANEL_HF);
    assert.equal(synth.length, 0);
});

test('buildVoteRows synthesized hf-vote-3 has cost_usd null when panel members lack cost', () => {
    // HF panel members have cost_usd: null because HF Inference Providers
    // does not return per-call cost. The synthesized row's cost should
    // reflect that — sumOrNull returns null when no member contributed.
    const input = hfPanelRows('row_1', 'Supported',
        ['Supported', 'Supported', 'Supported']);
    const synth = buildVoteRows(input, PANEL_HF);
    const v3 = synth.find(r => r.provider === 'hf-vote-3');
    assert.equal(v3.cost_usd, null);
});

test('buildVoteRows strip filter also removes prior hf-vote-N synthesized rows', () => {
    const hfRows = hfPanelRows('row_1', 'Supported',
        ['Supported', 'Supported', 'Supported']);
    const stale = [
        row('row_1', 'hf-vote-3', 'Not supported', 'Supported'),
        row('row_1', 'hf-vote-3-binary', 'Not supported', 'Supported')
    ];
    const input = [...hfRows, ...stale];
    const synth = buildVoteRows(input, PANEL_HF);
    assert.equal(synth.length, 2);
    const v3 = synth.find(r => r.provider === 'hf-vote-3');
    assert.equal(v3.predicted_verdict, 'Supported');
});
