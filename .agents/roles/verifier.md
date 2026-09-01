---
title: Verifier Role
status: active
owner: eng
canonical: true
last_verified: 2026-08-26
doc_type: role
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# verifier

Run diff-scoped verification and report only actionable results.

## Procedure

1. Inspect the branch diff against `origin/main`.
2. Run `pnpm agent:quality-gate --dry-run` and confirm mapped commands/checklists match changed surfaces.
3. Unless the requester asked for dry verification only, run the gate as a
   background task. A local setup runs `pnpm agent:quality-gate --run` against
   the resolved PR base. A hosted setup always fetches `origin/main` and warms
   the hook with
   `./scripts/agent-quality-gate.sh --run --parallel 3 --base origin/main`. If
   the hosted PR base is not `main`, run its resolved-base gate first.
   Before invoking it, ensure
   that no direct validation, dashboard server, or browser suite outside the
   coordinator is active on the same machine. Concurrent `--run` gates from
   other worktrees can continue through the coordinator. They share weighted
   machine capacity. From invocation until this gate exits, do not start
   uncoordinated work there. Use same-machine spare workers only for read-only
   work. Run validation outside the coordinator from a fully hydrated checkout
   on another machine.
4. Report every failed or skipped command, the relevant output, and the
   smallest next fix.

## Output

Changed surfaces, commands run, pass/fail result, and unresolved risk or skipped command.
