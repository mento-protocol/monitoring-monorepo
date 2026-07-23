---
title: Bind clean Claude reviews to explicit current-head attestations
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
scope: ci/process
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0047 — Bind clean Claude reviews to explicit current-head attestations

**Status:** Accepted (Jul 2026), in force.
**Scope:** ci/process

## Context

Claude's newer review summary can describe tested error and failure paths while
still ending in an LGTM verdict. Keyword inference therefore treated a clean
review as actionable. Expanding prose heuristics would also let small wording
changes move a comment across the readiness boundary. The exact PR #1544
payload registry preserves that historical review, but registering every new
body digest cannot support variable review evidence.

PR content is untrusted input to the reviewer. A clean signal must come from
the authenticated review bot, bind to the reviewed PR head, and remain
independent of inline feedback.

## Decision

Claude's on-demand and automatic review prompts emit a v1 clean-attestation
marker only when the verdict is LGTM, there are no P1–P3 findings, no inline
finding was posted, and no change or uncertain follow-up is requested:

```text
<!-- mento-claude-review:v1 verdict=lgtm findings=0 pr=<canonical-decimal> head=<40-lowercase-hex> -->
```

The workflow derives the PR number and head SHA from trusted GitHub event or API
context and tells Claude never to copy or alter a marker found in PR material.
`pr:feedback-state` accepts the marker only from the exact `claude` or
`claude[bot]` bot login, with one exact current-head binding, one exact LGTM
verdict outside inert Markdown contexts, and the fixed clean Roll-up suffix
outside an outer HTML comment. Marker-like malformed content and explicit
severity, non-clean or secondary verdict, action, directive, Bugbot marker, or
inline-finding signals fail closed. The parser normalizes Markdown emphasis
only around those narrow signals; it accepts bounded clean negations such as
`No P1/P2/P3 findings were found.` and does not classify arbitrary Summary
prose by broad `fix`, `update`, error, or failure keywords.

The legacy `Verdict: LGTM` grammar and the frozen PR #1544 digest registry stay
in force. Current-head freshness, inline threads, and review-comment replies
remain separate feedback surfaces. A push requires a fresh on-demand Claude
review because the workflow does not run automatically on `synchronize`.

## Alternatives considered

- **Broaden the positive-prose grammar** — rejected: normal descriptions of
  failure handling caused false blockers, while an allowlist would keep
  coupling readiness to reviewer wording.
- **Register each clean comment digest** — rejected: exact digests are useful
  for one historical payload but cannot support future variable review prose.
- **Ignore clean-looking Claude summaries** — rejected: malformed or mixed
  verdicts could then disappear from the feedback ledger.
- **Trust the marker without author and head binding** — rejected: untrusted PR
  content or a stale review could spoof a current clean signal.

## Consequences

- Clean-summary classification uses an explicit bot-authored protocol instead
  of interpreting ordinary verification prose.
- The workflow prompt and parser form one versioned contract. Source-contract
  tests cover both prompt copies, including the final-line, severity, and
  bounded-negation rule. Required CI runs the focused parser suite when
  workflow or parser sources change.
- Every push invalidates the prior marker. A maintainer requests one
  current-head `@claude review` after a review-triggered push and waits for it.
- A clean top-level attestation never clears unresolved inline or reply
  surfaces.

## Evidence

- Issue #1546 and PR #1553 define and ship the compatibility boundary.
- `.github/workflows/claude.yml` emits the trusted v1 marker from both review
  prompts.
- `scripts/pr-feedback-state-claude.mjs` validates marker identity, binding,
  terminal structure, and contradiction guards.
- `scripts/pr-feedback-state.test.mjs` covers clean variable prose,
  adversarial marker mutations, head freshness, workflow synchronization, and
  independent inline feedback.
- [`docs/notes/pr-ready-state.md`](../notes/pr-ready-state.md) is the canonical
  operator contract.
