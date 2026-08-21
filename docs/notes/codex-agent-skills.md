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
`~/.codex/config.toml`. Project config may define a complete, credential-free
shared MCP launcher, as the checked-in `chrome-devtools` server does. Do not add
partial project entries that depend on a personal server definition: Codex
Cloud does not inherit personal config, and Codex rejects an enabled server
without a transport. Keep machine-specific transport and all authentication or
secret material, including secret-bearing command arguments, environment
values, headers, and tokens, out of the repository. Secret provisioning and
rotation remain in the owning IaC path under
[ADR 0030](../adr/0030-iac-before-cli-secrets.md).

The optional forensic-upload Upstash server is deliberately personal and local
only. Its reviewed package pin, credential-name forwarding, Cloud boundary,
human-owned key lifecycle, and focused validation live in
[`upstash-mcp-operator.md`](upstash-mcp-operator.md). Do not add its transport or
an enabled-only toggle to `.codex/config.toml`.

Treat MCP diagnostics as secret-adjacent. Do not use `codex mcp list` in shared
logs when a personal server may contain credential-bearing arguments; inspect
only redacted structural fields such as server name, enabled state, and
transport presence.

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
same name. `ship` and `babysit-pr` are not merged with the repo copies — the
repo files are not read at all, so those two are Codex-facing only. A skill
whose name does not collide loads normally alongside the personal set.

A shadowed session loses no rule **because no rule lives only in those two
files**. Repo-specific rules reach every surface through three routes, and any
new rule must take one of them:

1. **Repo docs.** `CLAUDE.md` loads in every session and routes to
   [`pr-operating-card.md`](pr-operating-card.md) and its authorities; the
   personal `ship` skill reads repo instructions first and prefers them.
2. **The babysit hook.** `.claude/babysit-pr.sh` is discovered by path
   convention and sourced by whichever babysit skill ran, so it gates both. It
   owns the `pr:ready-state` gate and the fork-head refusal.
3. **A non-colliding skill name**, for work that needs its own entry point.

Do not resolve the collision by renaming `ship` or `babysit-pr`; the running
session's skill listing, not this note, is the runtime truth for which copy
loaded. Verify with a headless probe that exits non-zero when the assumption
breaks, rather than one whose prose has to be read:

```bash
set -o pipefail  # otherwise only the parser's status is seen and a failed CLI call reads as a bad skill set
claude -p "List every skill named exactly 'ship' or 'babysit-pr'. Reply with only a JSON array of the names, no prose." \
  --model opus --output-format json |
  python3 -c 'import sys,json,re; r=json.load(sys.stdin).get("result","");m=re.search(r"\[.*\]",r,re.S);n=sorted(json.loads(m.group(0)) if m else []);print(n);sys.exit(0 if n==["babysit-pr","ship"] else 1)'
```

Exit 0 means one skill resolved per name, as expected. A non-zero exit means the
collision behaviour changed and the routing above needs rechecking.

**This checks the name set, not which copy won**, and that limit is real rather
than an oversight: the CLI reports resolved skill names, not the file behind
each. If precedence ever flipped so the repo copy won, the probe would still exit 0. Asking the model whether its skill contains some repo-only phrase does not
close the gap either — it answers by reading the file from disk and reports
`yes` regardless of which copy actually loaded, which was verified rather than
assumed.

So treat the exit code as a check on the _collision_, not on the _winner_. The
winner is observable only by consequence: if a session in this repo starts
following a rule that exists solely in the repo copy, precedence has changed and
this note is wrong. That is why no rule may live solely in those two files —
the routing above is designed so the answer stops mattering.

## Codex Cloud routing

Codex Cloud does not inherit a developer's local `~/.agents`, `~/.codex`, or
`~/.claude` directories. Configure the environment setup and optional
maintenance scripts as:

```bash
./scripts/bootstrap/codex-cloud-setup.sh
./scripts/bootstrap/codex-cloud-maintenance.sh
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
documented: `scripts/repo-health/check-skills-mirror.mjs` byte-compares the two
trees and fails on any drift, and the Agent Quality Gate runs it automatically
whenever either tree changes. Symlinking the trees was rejected — repo files
pushed via the GitHub Contents API and hosted/web checkouts are not guaranteed
to preserve symlinks, so a check script is the safer default. Run
`node scripts/repo-health/check-skills-mirror.mjs` after editing either copy.

## SessionEnd hook

`scripts/bootstrap/agent-session-end-hook.sh` runs on SessionEnd for Claude Code
and Codex.
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
