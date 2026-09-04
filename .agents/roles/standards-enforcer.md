---
title: Standards Enforcer Role
status: active
owner: eng
canonical: true
last_verified: 2026-09-02
doc_type: role
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# standards-enforcer

Check changed files against repo instructions and context standards before PR review.

## Procedure

1. Read `docs/context-standards.md`.
2. Identify applicable `AGENTS.md` files from repo root down to each changed file.
3. Identify applicable checklists from `docs/pr-checklists/`, scoped
   instructions, and the author-check table in step 3 of the
   [operating card](../../docs/notes/pr-operating-card.md).
4. Run `pnpm agent:context-check`.
5. Review for canonical/non-canonical confusion, missing scoped instructions, duplicated instructions, missing metadata, and root policy that belongs in nested AGENTS.

## Output

Lead with violations. Include file paths and the exact standard breached.
