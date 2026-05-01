# design-plans/

Date-prefixed design proposals for non-trivial changes — anything where the *why* and the *alternatives considered* matter enough to outlive a PR description.

## Filename

`YYYY-MM-DD-<slug>.md`. The date is when the design was **drafted**, not when it was implemented or merged. Slugs are short and descriptive (`ci`, `deferred-manual-csv-review`).

## Status header

Every file opens with a single blockquote line. A reader should know within five seconds whether the doc is load-bearing or historical:

```markdown
> **Status (YYYY-MM-DD):** <state>. <one-sentence pointer to the active version, if applicable>.
```

States in use:

| State | Meaning |
| --- | --- |
| **Proposed** | Drafted, not started. Open to alternatives. |
| **In progress** | Implementation underway on a named branch or PR. The doc may have stale references; flag them inline. |
| **Implemented** | Shipped. Doc kept for the design-discussion record. |
| **Deferred** | Paused, not rejected. Often pivoted to a different approach. Note the pivot target. |
| **Superseded** | Replaced by a newer design. Add `> **Superseded by <pointer>**` and stop. |
| **Dropped** | Decided against. Worth keeping the doc so the next person doesn't re-propose the same thing without context. |

## When to add a doc here

- A change with non-trivial scope where the alternatives considered are worth recording.
- A path that was tried and pivoted away from — capturing it prevents re-litigating.
- An external constraint (legal, infrastructure, third-party API) that shaped a decision and would otherwise be invisible.

Skip this directory for: bug-fix rationale (PR description), one-off code-comment-sized notes (inline), or routine refactors.

## When to evolve a doc

- Status change → update the header, keep the body.
- Replaced approach → add a `> **Superseded by ...**` line near the top, leave the original prose intact. Don't rewrite history.
- Implementation drifted → add an inline note pointing to the divergence; don't silently rewrite the design to match the code.
