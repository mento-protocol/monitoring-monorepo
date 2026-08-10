---
title: Codex Agent Skills
status: active
owner: eng
canonical: true
last_verified: 2026-08-10
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
`~/.codex/config.toml`. Project config may define a credential-free shared MCP
launcher, as the checked-in `chrome-devtools` server does, or enable or disable
a server already defined in personal config. An `enabled`-only override requires
the same named server and its transport in personal config; otherwise Codex
rejects the incomplete entry. Add that user-level server first through the
official [Codex MCP configuration guide](https://developers.openai.com/codex/mcp#configure-with-configtoml).
Keep machine-specific transport and all authentication or secret material,
including secret-bearing command arguments, environment values, headers, and
tokens, out of the repository.

The checked-in `upstash` toggle expects this user-level entry, using the
[upstream Upstash MCP server](https://github.com/upstash/mcp-server#openai-codex):

```toml
[mcp_servers.upstash]
command = "npx"
args = [
  "-y",
  "@upstash/mcp-server@latest",
  "--email",
  "<UPSTASH_EMAIL>",
  "--api-key",
  "<UPSTASH_API_KEY>",
]
startup_timeout_sec = 20
```

Replace the placeholders only in `~/.codex/config.toml`. Create the API key in
the Upstash Console, prefer a read-only key when its reduced tool set is enough,
and never commit or paste the populated entry into logs.

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

## Claude global-store shadowing

In a Claude Code session, a user-global skill wins over a repo skill with the
same name, so personal `ship` or `babysit-pr` implementations shadow the repo
copies when present. That is accepted: the repo copies stay canonical for
Codex and for the cloud capability-gate adaptations, whose binding rules also
live in [`github-tooling-surfaces.md`](github-tooling-surfaces.md), so a
shadowed Claude session loses no rule. Do not resolve the collision by
renaming either side; the running session's skill listing, not this note, is
the runtime truth for which copy loaded.

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

Use the owning skill's foreground watcher for a long-running external process
instead of `/loop` plus cron, which creates a full turn and notification at
every interval. The `deploy-indexer` skill's Phase 2 is the canonical example:
`pnpm deploy:indexer:status --watch --compact` polls internally, while the active
agent session or a surface-native Monitor enforces the wall-clock deadline.
`babysit-indexer-deploy` is a compatibility command for that same contract.
The repo-local `babysit-pr` skill provides the portable readiness-watch fallback
for PRs.
