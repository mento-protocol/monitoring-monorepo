---
name: autoreview
description: Run the repo-local structured closeout review helper after non-trivial edits, PR feedback batches, or before ship. Default engine is Codex; Claude is supported with --engine claude.
title: Auto Review
status: active
owner: eng
canonical: true
last_verified: 2026-05-27
---

# Auto Review

Run a structured second-model review as a closeout check. This is a local
quality step, not GitHub approval routing and not a replacement for
`pnpm pr:ready-state`.

Use when:

- The user asks for `autoreview`, Codex review, Claude review, or a second-model
  review.
- A non-trivial code change is ready for closeout.
- A PR feedback batch has been fixed locally and cheap checks already pass.
- You are about to ship or update a PR with behavioral, workflow, security,
  data-flow, or UI impact.

Skip for trivial docs copy, pure formatting, generated-only output, or
mechanical rename work where a second model adds little value.

## Contract

- Treat review output as advisory. Verify every finding against the real code
  path before editing.
- Prefer small fixes at the right ownership boundary. Do not refactor only to
  satisfy a speculative review note.
- Use review at batch boundaries, not after every small edit.
- If a review-triggered fix changes code, rerun focused tests and rerun
  autoreview once for that fixed batch.
- Stop when the helper exits 0 with no accepted/actionable findings. Do not run
  extra review passes for nicer wording.
- Never push just to review. Push only when the user asked for push, ship, or PR
  update.
- Preserve the repo's PR all-clear gate: after pushing and replying to comments,
  `pnpm pr:ready-state --pr <number> --json` is still the readiness source of
  truth.

## Command

Canonical repo entrypoint:

```bash
pnpm agent:autoreview
```

Direct helper path, useful from either Codex or Claude Code:

```bash
.agents/skills/autoreview/scripts/autoreview --help
```

Claude Code may also use the mirrored helper path:

```bash
.claude/skills/autoreview/scripts/autoreview --help
```

The helper defaults to `AUTOREVIEW_ENGINE` or `codex`. Use Claude explicitly
when requested:

```bash
pnpm agent:autoreview -- --engine claude
```

## Pick Target

Dirty local work:

```bash
pnpm agent:autoreview -- --mode local
```

Use local mode only when the patch is actually unstaged, staged, or untracked in
the current checkout.

Branch or PR work:

```bash
pnpm agent:autoreview -- --mode branch --base origin/main
```

If an open PR exists, use its actual base:

```bash
base=$(gh pr view --json baseRefName --jq .baseRefName)
pnpm agent:autoreview -- --mode branch --base "origin/$base"
```

Committed single change:

```bash
pnpm agent:autoreview -- --mode commit --commit HEAD
```

Use commit review for already-committed or already-pushed work where branch
review would be empty or too broad.

## Repo Context

For this repository, include focused context when relevant:

```bash
pnpm agent:autoreview -- --prompt-file docs/pr-checklists/recurring-review-patterns.md
```

For stateful data or UI flows, also pass:

```bash
pnpm agent:autoreview -- --prompt-file docs/pr-checklists/stateful-data-ui.md
```

For PR feedback batches, add a short prompt that identifies the fixed feedback
class:

```bash
pnpm agent:autoreview -- --mode branch --base origin/main \
  --prompt "Feedback-batch verification: check that the fix resolves the review finding, sibling surfaces were audited, and no regression was introduced."
```

## Workflow Placement

Normal ship/update sequence:

1. Implement and run focused checks while editing.
2. Run `pnpm agent:quality-gate --run` for the batch.
3. Run `pnpm agent:autoreview` for non-trivial batches.
4. Verify any accepted findings with code reading, then fix or reject them.
5. If code changed because of review, rerun focused checks and autoreview once.
6. Push only after the batch is clean.
7. Reply to every PR review comment, including rejected findings.
8. Run `pnpm pr:ready-state --pr <number> --json` before all-clear.

## Final Report

Include:

- autoreview command used
- tests or proof run
- accepted findings fixed, or rejected findings with a brief reason
- final clean helper result, or why a remaining finding was intentionally left
  unchanged
