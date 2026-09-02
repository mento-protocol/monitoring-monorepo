---
title: New Worktree / Clone Setup and Claude Code on the Web Setup
status: active
owner: eng
canonical: true
last_verified: 2026-09-02
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# New Worktree / Clone Setup and Claude Code on the Web Setup

The invocation pointer lives in the "Agent Tooling and Setup" section of root
`AGENTS.md`. This note holds the underlying mechanics.

## New Worktree / Clone Setup

macOS setup requires the Xcode Command Line Tools (`xcode-select --install`)
for the optional legacy gate's Darwin helper. Linux does not need them.

After creating a new worktree manually or cloning the repo, run:

```bash
./scripts/setup.sh
```

This configures the tracked pre-commit formatting hook, installs dependencies,
builds `shared-config`, and ensures Envio codegen has produced the generated
type facade required for `indexer-envio` TypeScript to compile. It also attempts to
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

Fresh per-PR worktrees start warm because `setup.sh`,
`bootstrap-worktree.sh`, and the optional legacy gate all point Turbo at one
shared local cache directory outside any worktree. The mechanics, the fallback
when that directory is unset or unwritable, and the `AGENT_TURBO_SHARED_CACHE=0`
opt-out are owned by
[agent-quality-gate-mechanics.md](agent-quality-gate-mechanics.md).

## Claude Code on the web setup

Claude Code on the web sessions run in a hosted container that does not inherit
the user's local `~/.claude` skills or shell environment. The repo bootstraps
itself through a SessionStart hook (`.claude/settings.json` →
`.claude/hooks/session-start.sh`) that delegates to:

```bash
./scripts/bootstrap/claude-code-web-setup.sh
```

The heavy bootstrap runs only for a remote startup event, not local sessions,
resume, or compact. It installs dependencies, prewarms Trunk, runs the context
check, builds/code-generates the required packages, configures available
GitHub/MCP integration, and attempts a Playwright Chromium install for the
dashboard browser fixture suite. The Playwright step prefers a preinstalled
Chromium under `/opt/pw-browsers` when the container image ships one
(detected via `find`/`test`, exported as `PLAYWRIGHT_BROWSERS_PATH`) and
otherwise falls back to downloading from `cdn.playwright.dev`, now
allowlisted in this environment; either way the step is non-fatal, so a
still-blocked download or a missing preinstall only warns instead of failing
the bootstrap. The `PLAYWRIGHT_BROWSERS_PATH` export covers only the
bootstrap subprocess itself: the script has no shell-profile persistence
mechanism, so it does not carry over to later, separate Bash tool shells in
the same session — the bootstrap log (below) and the in-script WARN explain
how to set it manually if a later `test:browser` run needs it.

The bootstrap's combined stdout/stderr is teed to the gitignored
`.claude/logs/web-setup.log` (created by the SessionStart hook), overwritten
each run, so a failed or degraded bootstrap leaves a diagnosable trace on
disk even though the hook still routes that same output only to stderr to
keep it out of the agent's context.

### Measured host reality in a hosted container

Measured on 2026-08-26 in a live cloud session (issue #2057), with `trunk.io`,
`*.trunk.io`, and `cdn.playwright.dev` added to the Custom allowlist on top of
the Trusted defaults:

- `trunk.io`, `nodejs.org`, and `registry.npmjs.org` answer 200. Trunk's
  hermetic runtimes and its npm-sourced linters download normally.
- `github.com` does not. The platform's credential proxy intercepts it and
  gates it per session, answering 403 with "GitHub access to this repository
  is not enabled for this session". No allowlist entry lifts that.
- That reaches Trunk's plugin archive (`github.com/trunk-io/plugins`) and its
  GitHub-release linters. A cold Trunk cache therefore fails the check with
  `Unable to download plugin <url>: HTTP 403 '<url>'`. The image ships a
  prewarmed cache holding both, which masks the block on a warm run.
  `tools/trunk` reads `$TRUNK_CACHE`, else `$XDG_CACHE_HOME/trunk`, else
  `~/.cache/trunk`, so prewarming only the last one misses a session that sets
  either override.
- The optional legacy gate classifies that cold-cache 403 as
  environment-blocked and skips its Trunk arm instead of hard-failing; a 404
  stays a hard failure. See
  [agent-quality-gate-mechanics.md](agent-quality-gate-mechanics.md).

If the container's Node major is older than the repo's `.node-version` (for
example, an image shipping Node v22 against a `.node-version` of `24`), the
bootstrap does not attempt to switch the running interpreter — corepack only
manages package-manager shims, not Node itself, and `pnpm env use --global`
would install that Node under `PNPM_HOME` rather than change the running
interpreter. A later shell picks it up only when its `PATH` carries the
pnpm-managed bin directory, and nothing here puts it there, so the agent's
separate Bash tool shells keep the image's Node. The download itself would work
— `nodejs.org` is reachable, per the measurements above. The script instead
prints one clear WARN naming the mismatch and how to fix it env-side (rebuild/select a Node-24 container image); the
mismatch itself only produces non-fatal pnpm engine-range warnings, since no
root `.npmrc` sets `engine-strict`.

### Workaround: directory-listing denies block `ls`, not `test`

This repo's sandbox read-deny rules (e.g. `Read(**/node_modules/**)`) also
block Bash `ls` on the denied path, because `ls` needs to read the directory
listing. Existence and non-emptiness checks on such paths still work via
`test -d`/`test -f`/`find … -print -quit`, which the Playwright preinstall
detection above relies on. Prefer that pattern over `ls` for any check on a
denied path in a hosted or sandboxed session.

Repo-local `ship` and `babysit-pr` skill adapters live under `.claude/skills/`
(mirrored under `.agents/skills/` for Codex), so the familiar `/ship` and
`/babysit-pr` workflows resolve to the repo-visible PR operating card,
`pnpm agent:autoreview`, and `pnpm pr:ready-state` without needing a
developer's personal skills present.

### GitHub access in hosted sessions: gh is unreliable

In Claude cloud sessions the platform's GitHub credential proxy blocks
GraphQL regardless of tokens or allowlist entries, and the gh binary is not
reliably available either (`gh auth status` still passes when it is, so it
is not a capability signal). REST `/repos/*` behavior varies by session
rather than being a fixed blanket block — see
[`github-tooling-surfaces.md`](github-tooling-surfaces.md) for the current
empirical findings. `pnpm pr:ready-state` cannot run absent the
capability-gate exception, because it rides on GraphQL either way. Hosted
sessions use the GitHub MCP tools
plus the `babysit-pr` cloud watch loop; the foreground
`pnpm pr:ready-state --pr <number> --watch --compact --until-ready` loop
remains the local fallback when the Claude `Monitor` tool is unavailable.
Mechanics, the gh→MCP mapping, and the empirical findings live in
[`github-tooling-surfaces.md`](github-tooling-surfaces.md).
