# docs/

Project documentation that isn't a top-level `README.md` or `CLAUDE.md`. Two kinds of file live here:

- **Reference / overview docs** at the top of `docs/` describe how parts of the system work today (research notes, schema references, integration points).
- **Design plans** under `docs/design-plans/` are date-prefixed proposals for changes. Each one carries its own status header noting whether the work is proposed, in progress, deferred, or superseded — read the header before assuming the doc reflects current code.

## Contents

| File | Status | Topic |
| --- | --- | --- |
| `llm-benchmarking-overview.md` | reference | LLM-benchmarking research notes (background for the benchmark suite) |
| `researcher-feedback-review.md` | reference | Review of feedback on the user-research data-collection design |
| `worker-logging-reference.md` | reference | `publicai-proxy` worker `/log` endpoint and Neon DB schema |
| `design-plans/2026-04-26-ci.md` | in progress | Five-tier GitHub Actions CI design; implementation on `add-github-actions-ci` branch |
| `design-plans/2026-04-28-deferred-manual-csv-review.md` | deferred | Manual-review path for the held-back CSV expansion (deferred in favor of the WMF-reliable-subset approach that shipped as #151) |

## Conventions

- Design plans use a `YYYY-MM-DD-<slug>.md` filename. The date reflects when the design was drafted, not when it was implemented.
- Every design plan opens with a `> **Status (date):** ...` blockquote so a casual reader can tell within five seconds whether the doc is load-bearing or historical.
- When a design is superseded, prefer adding a `> **Superseded (date):** see <pointer>` line to the existing file rather than deleting — preserves the design discussion as context for the next attempt.
