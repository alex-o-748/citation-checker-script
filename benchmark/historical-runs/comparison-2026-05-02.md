# January (2026-01-20) vs April (2026-04-19) userscript prompt — same dataset, same models

- Generated: 2026-05-02T19:42:30.575Z; rescored: 2026-05-09 (7 v1 rows downgraded Supported → Partially supported); rescored again 2026-05-14 against the additional WP:V-audit corrections in the same `docs/design-plans/2026-05-08-gt-audit-corrections.md` (4 more v1 rows downgraded to Partially, 1 to Not supported — round 2 = row_29, row_48, row_54, row_3; round 2 also moved row_51 to Not supported)
- Dataset: v1+v2+v3, 187 rows, ground truth distribution 43.3% Supported / 31.6% Partially / 25.1% Not supported
- 5-model panel: openrouter-mistral-small-3.2, openrouter-olmo-3.1-32b, openrouter-deepseek-v3.2, claude-sonnet-4-5, gemini-2.5-flash; 0 errors on either run
- Plus two synthetic ensembles derived from the 3 OpenRouter panel members (`openrouter-vote-3` for 4-class majority, `openrouter-vote-3-binary` for binary collapse)

## Side-by-side accuracy

All values are %. Δ = April − January (positive = the April prompt helped this provider).

| Provider | Jan Exact | Apr Exact | Δ Exact | Jan Lenient | Apr Lenient | Δ Lenient | Jan Binary | Apr Binary | Δ Binary |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| openrouter-vote-3-binary | 58.8 | 59.9 | +1.1 | 84.5 | 86.1 | +1.6 | 84.5 | 86.1 | +1.6 |
| gemini-2.5-flash | 66.3 | 62.6 | -3.7 | 78.6 | 80.7 | +2.1 | 79.1 | 80.7 | +1.6 |
| claude-sonnet-4-5 | 46.5 | 46.0 | -0.5 | 64.2 | 65.8 | +1.6 | 81.8 | 82.4 | +0.5 |
| openrouter-deepseek-v3.2 | 38.5 | 46.0 | +7.5 | 57.8 | 66.8 | +9.1 | 78.6 | 85.0 | +6.4 |
| openrouter-mistral-small-3.2 | 41.2 | 46.5 | +5.3 | 67.9 | 71.7 | +3.7 | 83.4 | 83.4 | +0.0 |
| openrouter-vote-3 | 42.2 | 44.9 | +2.7 | 66.3 | 68.4 | +2.1 | 84.5 | 85.0 | +0.5 |
| openrouter-olmo-3.1-32b | 40.6 | 36.4 | -4.3 | 58.8 | 57.2 | -1.6 | 74.3 | 73.3 | -1.1 |
