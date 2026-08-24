---
name: babysit-pr
description: '[repo-skill] Monitor monitoring-monorepo PR readiness using the repo''s shared pr:ready-state probe, fix required CI/review blockers, reply to review comments, and stop only at ALL_CLEAR, MERGED, CLOSED, or a stated deadline. Use when the user says "babysit PR", "monitor CI", "watch reviews", or asks to keep a PR green.'
title: Babysit PR Skill
status: active
owner: eng
canonical: true
last_verified: 2026-08-21
doc_type: skill
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# Babysit PR

Codex-facing entry point. It holds no rules of its own: everything binding
lives in the authority docs below, which every surface reads. A Claude session
loads the user-global `babysit-pr` skill instead of this file
([`codex-agent-skills.md`](../../../docs/notes/codex-agent-skills.md#claude-global-store-shadowing)),
so a rule written here and nowhere else would reach Codex only.

Work [`pr-operating-card.md`](../../../docs/notes/pr-operating-card.md) steps 6
and 7 end to end. Step 6 opens with the babysit-only entry binding — the
step-5 target precedence, `BASE_REPO`, both remotes, the head fields, and the
fork stop — so a bare `/babysit-pr` invocation resolves its target before the
first repo-local command rather than assuming step 5 already ran. The card
steps own the feedback sweep, the reply-before-resolve forms, the scope
baseline, and the two-projection readiness contract.

| Decision                                                                      | Authority                                                                                |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Readiness and feedback projections, Codex approval, break-glass               | [`pr-ready-state.md`](../../../docs/notes/pr-ready-state.md)                             |
| Repository trust preflight, merge-conflict review axes, bundle verification   | [`agent-quality-gate-mechanics.md`](../../../docs/notes/agent-quality-gate-mechanics.md) |
| Surface detection, gh capability gate, gh→MCP mapping, MCP-emulated labelling | [`github-tooling-surfaces.md`](../../../docs/notes/github-tooling-surfaces.md)           |
| Deferrals and issue lifecycle                                                 | [`agent-issue-workflow.md`](../../../docs/notes/agent-issue-workflow.md)                 |

## What this repo adds

- **Readiness is the probe, not a read of green checks.** `pnpm pr:ready-state`
  and `pnpm pr:feedback-state` decide, bound with `--repo <BASE_REPO>` resolved
  from the PR URL. `.claude/babysit-pr.sh` enforces this as a gate for any
  babysit skill that discovers it, including the user-global one.
- **Fork heads are refused**, not gated — at target resolution, before any
  repo-local probe, gate, or fix runs, on every surface. The repo's probes and
  bundle sequence assume a trusted `origin` serving the base repo.
  `.claude/babysit-pr.sh` fails closed on `isCrossRepository` as the backstop,
  not the first line.
- **Codex sign-off is required here** — a 👍 reaction on the PR description at
  or after the current head. A "no major issues" comment is context, not the
  sign-off.
- **Stacked PRs are normal**, typically after a `/ship` batch. When a watched PR
  merges, evaluate every open PR that depended on it before calling the batch
  healthy.
- **Never force-push or amend while babysitting.** `git fetch` before every
  push; reviewers push mid-session.

In a Claude cloud session without the capability gate, `pnpm pr:ready-state`
cannot run. The event-driven watch loop, the fork stop for that surface, and the
MCP-emulated labelling rule live in
[`github-tooling-surfaces.md`](../../../docs/notes/github-tooling-surfaces.md).
