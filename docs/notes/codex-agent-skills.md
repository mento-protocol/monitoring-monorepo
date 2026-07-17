---
title: Codex Agent Skills — Mechanics
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Codex Agent Skills

The invocation pointer (where skills live, autoreview command, Codex Cloud
scripts) lives in the "Codex Agent Skills" section of root `AGENTS.md`. This
note holds the underlying mechanics.

Repo-tracked project skills live under `.agents/skills/`. Keep durable,
team-shareable project workflows there instead of relying on local-only
`~/.codex` or `~/.claude` state. Cross-project personal skills belong in
`~/.agents/skills` and should be exposed to both agents through the
`~/.codex/skills` and `~/.claude/skills` mirrors. Project-level Codex MCP config
lives in `.codex/config.toml`; local personal Codex settings still belong in
`~/.codex/config.toml`.

`autoreview` is pinned in this repo through `scripts/agent-autoreview.mjs` and
exposed with `pnpm agent:autoreview`; Claude Code also has `/autoreview` as a
thin command shim. The repo adapter detects active Codex sandbox sessions and
uses the helper's local deterministic engine by default so the command does not
try to spawn unavailable nested `codex exec`; explicit `--engine` arguments and
`AUTOREVIEW_ENGINE` still take precedence. `AUTOREVIEW_HELPER` is an escape
hatch for intentional local testing or replacement, not a Cloud prerequisite.
The adapter also exposes `--prepare-bundle-dir <dir>` to create a repo-context
review bundle with changed paths, patch files, selected checklists, optional
`--feedback-pr` feedback state, and the helper's prepared prompt.
Keep the repo-local helper as the source of truth for this repo's required
ship gate; update it deliberately when taking upstream improvements from a
personal/global skill.

Codex Cloud does not inherit a developer's local `~/.agents`, `~/.codex`, or
`~/.claude` directories; setup and maintenance rely on the repo-local helper at
`scripts/agent-autoreview.mjs`, which fails fast if missing. PR shipping
requires `pnpm agent:autoreview` as the structured batch-boundary review.
Configure the environment setup script as `./scripts/codex-cloud-setup.sh` and
the optional maintenance script as `./scripts/codex-cloud-maintenance.sh`. Full
mechanics (GitHub CLI bootstrap, Trunk/Foundry install and mirror knobs, OSV
egress check, maintenance fast-path) live in
`docs/notes/codex-cloud-setup.md`.

For workflow continuity, this repo includes thin repo-local `ship` and
`babysit-pr` skill adapters under `.agents/skills/` with matching
`.claude/skills/` mirrors. They preserve the familiar command names while
backing the behavior with repo-visible commands: `pnpm agent:quality-gate`,
`pnpm agent:autoreview` when available, and `pnpm pr:ready-state`.

## SessionEnd hook (reflect nudge)

`scripts/agent-session-end-hook.sh` runs on SessionEnd for both Claude Code and Codex. When the session left commits or unstaged changes in the tree, it prints a one-line nudge to run `/reflect` so any new learnings get captured in memory / `AGENTS.md` / `CLAUDE.md` before context is lost. Silent on no-op sessions.

- Claude wiring: `.claude/settings.json` → `hooks.SessionEnd`.
- Codex wiring: `.codex/hooks.json`. Codex auto-disables new hooks until trusted; on first encounter, codex either prompts to trust or you mirror the entry into `~/.codex/hooks.json` and toggle `enabled = true` (set the hash) in `[hooks.state]` of `~/.codex/config.toml`. Or pass `--dangerously-bypass-hook-trust` for automation.

## Status-polling commands use `Monitor`, not `/loop`

For commands that watch a long-running external process (Envio sync, PR CI, deploy progress, etc.), prefer the `Monitor` tool over `/loop` + cron. Monitor runs a single shell script that polls internally at 30–60s and only emits stdout lines (== notifications) on state changes worth surfacing. Cron / `/loop` fires a full Stop turn per interval, which triggers a macOS notification regardless of whether anything changed — a 60-min sync produces ~12 idle notifications, vs 2–3 with Monitor. `babysit-indexer-deploy` and `babysit-pr` are the canonical examples; if you find yourself writing a new "watch X every Y minutes" command, model it on those.
