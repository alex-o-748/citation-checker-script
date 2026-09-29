# docs/

Project documentation that doesn't fit at the repo root. Two kinds of file live here:

- **Reference / overview docs** at the top of `docs/` describe how parts of the system work today (research notes, schema references, integration points).
- **Design plans** under `docs/design-plans/` are date-prefixed proposals for changes. Each carries its own status header — read it before assuming the doc reflects current code. See [`design-plans/README.md`](design-plans/README.md) for the status convention and lifecycle.

Two pages here are public-facing: [`verify-api.md`](verify-api.md) documents the Citation Verifier HTTP API for its users, and is the documentation link on its Toolforge entry; [`verification-framework.md`](verification-framework.md) defines claims, sources and verdicts, with examples. Keep both free of internal notes.
