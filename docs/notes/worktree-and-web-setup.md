---
title: New Worktree / Clone Setup and Claude Code on the Web Setup
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# New Worktree / Clone Setup and Claude Code on the Web Setup

The invocation pointer lives in the "Agent Tooling and Setup" section of root
`AGENTS.md`. This note holds the underlying mechanics.

## New Worktree / Clone Setup

After creating a new worktree manually or cloning the repo, run:

```bash
./scripts/setup.sh
```

This ensures deps are installed, Playwright Chromium is available for dashboard
browser tests, and Envio codegen has produced the generated type facade
required for `indexer-envio` TypeScript to compile.
Worktrunk-created worktrees (`wt switch --create` / `wt switch -c`) run the
same setup script automatically through `.config/wt.toml` as a blocking
`pre-start` hook before any launch command configured with `-x` starts.

The setup script optimizes repeated local worktrees by keeping dependency graph
validity, `shared-config` build validity, Playwright Chromium availability, and
Envio codegen on separate markers backed by real output checks. A source-only
`shared-config` change does not force a dependency relink, and an
already-installed Playwright Chromium binary does not rerun the installer for
every fresh macOS worktree. Linux still requires a per-worktree successful
Playwright installer marker because `--with-deps` also provisions host libraries
there.

## Claude Code on the web setup

Claude Code on the web sessions run in a hosted container that does not inherit
the user's local `~/.claude` skills or shell environment. The repo bootstraps
itself through a SessionStart hook (`.claude/settings.json` →
`.claude/hooks/session-start.sh`) that delegates to:

```bash
./scripts/claude-code-web-setup.sh
```

The script is gated on `$CLAUDE_CODE_REMOTE` so it is a no-op for local Claude
Code sessions. It performs the same install + codegen contract as
`./scripts/setup.sh` plus a Playwright Chromium install for the dashboard
browser fixture suite. The Playwright step is non-fatal: hosted environments
that restrict outbound access to `cdn.playwright.dev` will skip the download
and warn instead of failing the bootstrap.

Repo-local `ship` and `babysit-pr` skill adapters live under `.claude/skills/`
(mirrored under `.agents/skills/` for Codex), so the familiar `/ship` and
`/babysit-pr` workflows resolve to repo-visible commands (`pnpm
agent:quality-gate`, `pnpm agent:autoreview`, `pnpm pr:ready-state`) without
needing a developer's personal skills present.

### GitHub access in hosted sessions: gh is platform-blocked

The gh CLI cannot do repo-scoped API work in Claude cloud sessions, and this
is not fixable from the environment settings. The platform's GitHub credential
proxy intercepts `github.com`/`api.github.com` (it is independent of the
network-access allowlist — entries for GitHub hosts are inert), overrides any
client `Authorization` header (a `GH_TOKEN` env var is ignored), and serves
structured 403s for every `/repos/*` path and for GraphQL. `gh auth status`
still succeeds because `/user` is served, so it is not a capability signal.
`pnpm pr:ready-state` therefore cannot run in hosted sessions.

Hosted sessions use the GitHub MCP tools for PR/issue/API work and the
`babysit-pr` skill's cloud watch loop (webhook subscription plus scheduled
self check-ins) for monitoring; the foreground
`pnpm pr:ready-state --pr <number> --watch --compact` loop remains the local
fallback when the Claude `Monitor` tool is unavailable. The full gh→MCP
mapping and the empirical findings live in
[`github-tooling-surfaces.md`](github-tooling-surfaces.md).
