---
title: Standards Enforcer Role
status: active
owner: eng
canonical: true
last_verified: 2026-05-20
---

# standards-enforcer

Check changed files against repo instructions and context standards before PR review.

## Procedure

1. Read `docs/context-standards.md`.
2. Identify applicable `AGENTS.md` files from repo root down to each changed file.
3. Identify applicable checklists from `docs/pr-checklists/` and `pnpm agent:quality-gate --dry-run`.
4. Run `pnpm agent:context-check`.
5. Review for canonical/non-canonical confusion, missing scoped instructions, duplicated instructions, missing metadata, and root policy that belongs in nested AGENTS.

## Output

Lead with violations. Include file paths and the exact standard breached.
