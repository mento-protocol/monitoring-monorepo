---
title: Codex Agent Skills — Mechanics
status: active
owner: eng
canonical: true
last_verified: 2026-07-19
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Codex Agent Skills

The invocation pointer (where skills live, autoreview command, Codex Cloud
scripts) lives in the "Agent Tooling and Setup" section of root `AGENTS.md`. This
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
thin command shim. Its review target remains branch-local: base-to-`HEAD`
commits plus dirty tracked and untracked work, augmented by deterministic Mento
checks and repo-selected checklist/feedback context. The complete bundle is
never truncated. Prepared bundles losslessly split oversized targets into a
bounded pass index that one fresh-context reviewer must inspect completely.
Direct semantic-engine execution fails closed when more than one prompt would
be required, and bundle preparation fails closed if the full input cannot fit
the pass budget. Direct and prepared capture enforce a cumulative byte budget
before diffs, untracked files, or supplemental evidence accumulate in memory or
staging sidecars.

The repo adapter detects active Codex sandbox sessions and uses the helper's
local deterministic engine by default only when no engine is explicitly
selected, so the command does not try to spawn unavailable nested `codex exec`.
Explicit `--engine` arguments and `AUTOREVIEW_ENGINE` take precedence and fail
closed when the selected engine is unavailable; there is no silent fallback
from a semantic engine to local. Semantic engines run from an empty temporary
workspace with project configuration and inherited environment restricted to
the review contract. Claude preserves standard Vertex and AWS Bedrock
credential-chain inputs; path-valued AWS locators must resolve to regular files
outside the reviewed repository. A quiet semantic reviewer emits a progress
heartbeat every 60 seconds. `AUTOREVIEW_HELPER` is an escape hatch for
intentional local testing or compatible replacement, not a Cloud prerequisite.
Prepared-bundle replacements must implement the pinned helper CLI, including
`--source-snapshot-only`, bundle-output, and trusted-input flags.

The adapter also exposes `--prepare-bundle-dir <dir>` to create a repo-context
review bundle with changed paths, patch files, selected checklists, optional
`--feedback-pr` feedback state, and the helper's prepared prompt. Supplemental
evidence supplied directly must be a repo-relative regular UTF-8 file confined
to the worktree. Adapter-generated feedback state inside the trusted prepared
bundle directory is the only external-path exception. Sensitive paths and
credential-like content fail closed before a semantic handoff. Every bundle
artifact is staged together and the complete directory is published only after
the source fingerprint still matches. Its `helper-output.txt` names the final
published prompt/pass paths rather than ephemeral staging locations.
Prepared-bundle mode owns its `autoreview-prompt.md`, so it cannot be combined
with `--bundle-output`. The removed `--parallel-tests` mode must not be reintroduced;
`pnpm agent:quality-gate --run` owns test execution and isolation.

Branch and commit targets are frozen to one object ID before capture. The
helper fingerprints symbolic-branch or detached identity plus the selected
`HEAD`/worktree/untracked source, and the adapter compares that fingerprint
around prepared-bundle staging, so a same-commit branch switch, moving base ref,
or concurrent edit fails closed instead of mixing review snapshots. The
adapter's executable search path excludes the reviewed worktree and resolves
Git/GitHub CLI executables to external targets before capture.

Keep the repo-local helper as the source of truth for this repo's required ship
gate; update it deliberately when taking upstream improvements from a
personal/global skill. Freeze the review scope baseline before the first pass,
classify growth as in-scope/follow-up/stop, create an issue for valid follow-up
work, warn near twice the baseline, and pause after two review-triggered patch
cycles. A clean source review is not browser, CLI/API, generated-artifact, or
runtime proof; those verification paths and the final `pr:ready-state` gate
remain separate and required.

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

The repo-local `doc-garden` skill uses the same exact-mirror contract. It turns
a generated bounded packet into evidence-backed dispositions, guarded semantic
edits, link/catalog repair, and normal PR closeout; the detailed cadence and
queue behavior stay in `docs/notes/documentation-gardening.md`.

## SessionEnd hook (reflect nudge)

`scripts/agent-session-end-hook.sh` runs on SessionEnd for both Claude Code and Codex. When the session left commits or unstaged changes in the tree, it prints a one-line nudge to run `/reflect` so any new learnings get captured in memory / `AGENTS.md` / `CLAUDE.md` before context is lost. Silent on no-op sessions.

- Claude wiring: `.claude/settings.json` → `hooks.SessionEnd`.
- Codex wiring: `.codex/hooks.json`. Codex auto-disables new hooks until trusted; on first encounter, codex either prompts to trust or you mirror the entry into `~/.codex/hooks.json` and toggle `enabled = true` (set the hash) in `[hooks.state]` of `~/.codex/config.toml`. Or pass `--dangerously-bypass-hook-trust` for automation.

## Status-polling commands use `Monitor`, not `/loop`

For commands that watch a long-running external process (Envio sync, PR CI, deploy progress, etc.), prefer the `Monitor` tool over `/loop` + cron. Monitor runs a single shell script that polls internally at 30–60s and only emits stdout lines (== notifications) on state changes worth surfacing. Cron / `/loop` fires a full Stop turn per interval, which triggers a macOS notification regardless of whether anything changed — a 60-min sync produces ~12 idle notifications, vs 2–3 with Monitor. `babysit-indexer-deploy` and `babysit-pr` are the canonical examples; if you find yourself writing a new "watch X every Y minutes" command, model it on those.
