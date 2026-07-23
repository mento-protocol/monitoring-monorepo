---
title: Codex Agent Skills
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Codex Agent Skills

The invocation pointer lives in root `AGENTS.md`. This note owns skill placement,
Codex Cloud routing, the SessionEnd hook, and long-running watch guidance.

## Skill ownership

Repo-tracked project skills live under `.agents/skills/`. Keep durable,
team-shareable project workflows there instead of relying on local-only
`~/.codex` or `~/.claude` state. Cross-project personal skills belong in
`~/.agents/skills` and should be exposed to both agents through the
`~/.codex/skills` and `~/.claude/skills` mirrors. Project-level Codex MCP config
lives in `.codex/config.toml`; local personal Codex settings belong in
`~/.codex/config.toml`.

## Autoreview routing

`autoreview` is pinned through `scripts/agent-autoreview.mjs` and exposed as
`pnpm agent:autoreview`; Claude Code's `/autoreview` command is a thin shim. The
command reviews the complete branch-local target. Oversized targets use a
lossless prepared-bundle index that one fresh-context reviewer must inspect in
full.

The target-selection, engine-isolation, sensitive-input, runtime-trust,
prepared-bundle, and runtime-changing-PR contracts live in
[`agent-quality-gate-mechanics.md`](agent-quality-gate-mechanics.md). Keep that
note as their single owner instead of copying implementation details here.
Autoreview is source review only: mapped quality gates, browser checks,
generated-artifact checks, runtime verification, and final PR readiness remain
separate.

## Codex Cloud routing

Codex Cloud does not inherit a developer's local `~/.agents`, `~/.codex`, or
`~/.claude` directories. Configure the environment setup and optional
maintenance scripts as:

```bash
./scripts/codex-cloud-setup.sh
./scripts/codex-cloud-maintenance.sh
```

Both paths rely on the repo-local autoreview helper. GitHub CLI bootstrap,
Git/credential setup, Trunk and Foundry installation, dependency/codegen checks,
and maintenance behavior live in
[`codex-cloud-setup.md`](codex-cloud-setup.md).

## Repo skill adapters

The repo-local `ship` and `babysit-pr` skills under `.agents/skills/` have exact
`.claude/skills/` mirrors. They preserve the familiar workflow names while
backing behavior with repo-visible commands such as `pnpm agent:quality-gate`,
`pnpm agent:autoreview`, and `pnpm pr:ready-state`.

The `doc-garden` skill uses the same exact-mirror contract. It turns a generated
bounded packet into evidence-backed dispositions, guarded semantic edits,
link/catalog repair, and normal PR closeout. The cadence and queue contract live
in [`documentation-gardening.md`](documentation-gardening.md).

The `.agents/skills/` ↔ `.claude/skills/` mirror is enforced, not just
documented: `scripts/check-skills-mirror.sh` byte-compares the two trees and
fails on any drift, and the Agent Quality Gate runs it automatically whenever
either tree changes. Symlinking the trees was rejected — repo files pushed via
the GitHub Contents API and hosted/web checkouts are not guaranteed to
preserve symlinks, so a check script is the safer default. Run
`bash scripts/check-skills-mirror.sh` after editing either copy.

## SessionEnd hook

`scripts/agent-session-end-hook.sh` runs on SessionEnd for Claude Code and Codex.
When the session left commits or working-tree changes, it prints a one-line
`/reflect` nudge so durable learnings can be routed before context is lost. It is
silent on no-op sessions.

- Claude wiring: `.claude/settings.json` under `hooks.SessionEnd`.
- Codex wiring: `.codex/hooks.json`; trust and enable the repo hook when Codex
  prompts. The checked-in file proves the wiring, not user-local trust state.

## Status polling

For Claude commands that watch a long-running external process, prefer the
`Monitor` tool over `/loop` plus cron. Monitor can poll internally every 30–60
seconds while emitting only meaningful state changes; `/loop` creates a full
turn and notification at every interval. `babysit-indexer-deploy` is the
canonical Monitor example. The repo-local `babysit-pr` skill instead provides a
portable readiness-watch fallback when Monitor is unavailable.
