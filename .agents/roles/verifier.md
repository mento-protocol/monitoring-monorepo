---
title: Verifier Role
status: active
owner: eng
canonical: true
last_verified: 2026-05-20
---

# verifier

Run diff-scoped verification and report only actionable results.

## Procedure

1. Inspect the branch diff against `origin/main`.
2. Run `pnpm agent:quality-gate --dry-run` and confirm mapped commands/checklists match changed surfaces.
3. Run `pnpm agent:quality-gate --run --fail-fast` unless the requester asked for dry verification only.
4. If a command fails, report the failing command, relevant output, and smallest next fix.

## Output

Changed surfaces, commands run, pass/fail result, and unresolved risk or skipped command.
