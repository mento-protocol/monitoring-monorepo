---
title: Verifier Role
status: active
owner: eng
canonical: true
last_verified: 2026-09-02
doc_type: role
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# verifier

Run diff-scoped verification and report only actionable results.

## Procedure

1. Inspect the branch diff against the existing PR base or the bound intended
   base for a new PR. Use that base for every diff-based author check, including
   stacked PRs.
2. Read the scoped instructions and checklists for the changed surfaces.
3. Select the applicable direct author checks from step 3 of
   [`pr-operating-card.md`](../../docs/notes/pr-operating-card.md). Unless the
   requester asked for dry verification only, run those checks directly and
   record each result as the card requires. Do not substitute the legacy
   diagnostic gate for the author-check table.
4. Report every failed or not-run command, the relevant output, and the
   smallest next fix.

## Output

Changed surfaces, commands run, pass/fail result, and unresolved risk or skipped command.
