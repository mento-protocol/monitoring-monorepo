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

This configures the tracked git hooks, installs dependencies, builds
`shared-config`, and ensures Envio codegen has produced the generated type
facade required for `indexer-envio` TypeScript to compile. It also attempts to
install Playwright Chromium for dashboard browser tests. A blocked browser
download warns and continues; run
`pnpm --filter @mento-protocol/ui-dashboard exec playwright install --with-deps chromium`
before browser tests when the binary is still absent. A `pnpm patch` on
`blamer@1.0.7` (jscpd's transitive git-blame dependency) strips its shipped
`.idea/` directory so sandboxed installs no longer hit a deterministic EPERM
at `importPackage`.
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

To keep a fresh per-PR worktree from starting with a 100% cold Turbo cache,
`setup.sh`, `bootstrap-worktree.sh`, and the agent quality gate export
`TURBO_CACHE_DIR="$HOME/.cache/turbo-monitoring-monorepo"` (unless the caller
already set `TURBO_CACHE_DIR`, or opted out with `AGENT_TURBO_SHARED_CACHE=0`),
so every worktree reads and writes one shared local Turbo cache outside any
worktree. When `HOME` is unset or that directory cannot be created or written to
(e.g. a sandboxed agent whose writable allowlist excludes it), the scripts leave
`TURBO_CACHE_DIR` unset and fall back to Turbo's per-worktree default, so those
runs stay cold. Turbo 2.9.x writes each cache artifact through a temp file plus
atomic rename with PID-namespaced temp names and only reaps orphaned `.tmp` files
older than an hour, so concurrent gate runs in two worktrees share the dir
safely. The shared dir is not reclaimed when a worktree is deleted and grows
without bound; it is pure cache, so `rm -rf
"$HOME/.cache/turbo-monitoring-monorepo"` any time to reclaim disk (see
[agent-quality-gate-mechanics.md](agent-quality-gate-mechanics.md)). Remote
caching stays disabled (`turbo.json` `remoteCache.enabled: false`); this is local
sharing only. Refs GitHub issue 1411.

## Claude Code on the web setup

Claude Code on the web sessions run in a hosted container that does not inherit
the user's local `~/.claude` skills or shell environment. The repo bootstraps
itself through a SessionStart hook (`.claude/settings.json` →
`.claude/hooks/session-start.sh`) that delegates to:

```bash
./scripts/claude-code-web-setup.sh
```

The heavy bootstrap runs only for a remote startup event, not local sessions,
resume, or compact. It installs dependencies, prewarms Trunk, runs the context
check, builds/code-generates the required packages, configures available
GitHub/MCP integration, and attempts a Playwright Chromium install for the
dashboard browser fixture suite. The Playwright step is non-fatal: hosted
environments that restrict outbound access to `cdn.playwright.dev` warn
instead of failing the bootstrap.

Repo-local `ship` and `babysit-pr` skill adapters live under `.claude/skills/`
(mirrored under `.agents/skills/` for Codex), so the familiar `/ship` and
`/babysit-pr` workflows resolve to repo-visible commands (`pnpm
agent:quality-gate`, `pnpm agent:autoreview`, `pnpm pr:ready-state`) without
needing a developer's personal skills present.

### GitHub access in hosted sessions: gh is platform-blocked

In Claude cloud sessions the platform's GitHub credential proxy blocks gh's
repo API and GraphQL regardless of tokens or allowlist entries (`gh auth
status` still passes, so it is not a capability signal), and
`pnpm pr:ready-state` cannot run absent the capability-gate exception. Hosted sessions use the GitHub MCP tools
plus the `babysit-pr` cloud watch loop; the foreground
`pnpm pr:ready-state --pr <number> --watch --compact --until-ready` loop
remains the local fallback when the Claude `Monitor` tool is unavailable.
Mechanics, the gh→MCP mapping, and the empirical findings live in
[`github-tooling-surfaces.md`](github-tooling-surfaces.md).
