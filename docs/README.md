# docs/

Project documentation that doesn't fit at the repo root. Two kinds of file live here:

- **Reference / overview docs** at the top of `docs/` describe how parts of the system work today (research notes, schema references, integration points).
- **Design plans** under `docs/design-plans/` are date-prefixed proposals for changes. Each carries its own status header — read it before assuming the doc reflects current code. See [`design-plans/README.md`](design-plans/README.md) for the status convention and lifecycle.

## Measurement and benchmarking

- [`citation-verification-measurement-framework.md`](citation-verification-measurement-framework.md)
  defines the verdicts, explains their ambiguous boundaries, and introduces
  strict accuracy, supported-versus-everything-else accuracy, and ROC curves.
- [`roc-curves.md`](roc-curves.md) is the technical reference for generating and
  interpreting the benchmark's ROC data.
