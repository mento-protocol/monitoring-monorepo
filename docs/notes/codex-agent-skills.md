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
the review contract. Reviewer web search is disabled by default to keep
untrusted review evidence off the network; `--web-search` is an explicit opt-in
for reviews that require public documentation lookup. Claude preserves standard Vertex and AWS Bedrock
credential-chain inputs; path-valued AWS locators must resolve to regular files
outside the reviewed repository. A quiet semantic reviewer emits a progress
heartbeat every 60 seconds. `AUTOREVIEW_HELPER` is an escape hatch for
intentional local testing or compatible replacement, not a Cloud prerequisite.
Prepared-bundle replacements must implement the pinned helper CLI, including
`--source-snapshot-only`, `--serialize-untracked-file`, `--bundle-output`,
`--bundle-output-display`, and `--trusted-input-root`. The adapter keeps
replacement compatibility by invoking
that snapshot flag without a target mode; target-mode snapshot scoping is
passed only to the pinned repo helper.

The adapter also exposes `--prepare-bundle-dir <dir>` to create a repo-context
review bundle with changed paths, patch files, selected checklists, optional
`--feedback-pr` feedback state, and the helper's prepared prompt. Supplemental
evidence supplied directly must be a repo-relative regular UTF-8 file confined
to the worktree. Adapter-generated feedback state and protected-main checklist
copies inside the trusted prepared-bundle directory are the only external-path
exceptions. The adapter resolves `origin/main^{commit}` once and
uses that protected snapshot as checklist policy in every target mode; checklist
edits in the reviewed target remain diff evidence and cannot instruct their own
review. Sensitive paths and
credential-like content, private keys, wallet recovery phrases, Stripe live
keys, common webhook URLs,
and secret-bearing URL query parameters fail closed before a semantic handoff.
Evidence reads reject symlinks and path-swap races. The requested bundle parent
must already exist. Every canonical ancestor must be owned by the current user
or root, and group/other-writable ancestors require sticky-bit protection. The
adapter canonicalizes and pins that directory plus the
freshly created staging directory's `dev:ino` before content generation. It
stages every artifact beside the destination, manifests wrapper-owned evidence
before and after helper execution, validates the prompt set, and hashes the
complete evidence both before and after the final helper source check. The
manifest rejects symlinks, special files, externally linked regular
files, and any identity or content change. The validated Node runtime
exclusively reserves the destination, rechecks the staging identity throughout
transfer, and verifies that manifest after transfer and again immediately
before hard-linking `.agent-autoreview-complete` last. That marker binds the
manifest digest. Run `pnpm agent:autoreview --verify-bundle-dir <dir>`
immediately before one reviewer reads every bounded pass and retain the printed
digest outside the bundle. After review, rerun with
`--expected-bundle-manifest <retained-digest>`; the command rehashes the
no-follow evidence and rejects a changed marker, bundle, or pre/post digest. A
destination created during the final race window is never replaced; an
interrupted or unverified bundle must not be reviewed. Failure after an external
helper sees the staging path leaves that tree for identity-safe inspection
instead of recursively deleting a potential replacement. The adapter never
recursively removes a failed destination reservation; inspect and remove an
incomplete, unmarked directory before retrying. The repo helper is not
re-entered for publication. Its `helper-output.txt` names the final published
prompt/pass paths rather than ephemeral staging locations.
Prepared-bundle mode owns its `autoreview-prompt.md`, so it cannot be combined
with `--bundle-output` or `--dry-run`; publication requires completed content
validation and the main prompt plus every strictly ordered, deterministic
indexed bounded pass. Prompt-index validation accepts a UTF-8 BOM, CRLF line
endings, and leading blank lines only after normalization, then enforces the
same strict pass order and exact companion-file set, rejecting undeclared pass
files. Direct `--bundle-output` publication uses an exclusive same-directory
link and refuses every existing destination, including a file created in the
final race window, so partial multi-pass publication cannot corrupt a valid
index and its companions; use a fresh path or remove the prior set deliberately.
Automatic prepared-bundle
feedback resolves the unique same-repository
PR base, number, and canonical repository slug together, so the frozen patch
and `feedback-state.json` share one GitHub snapshot. Capture materializes the
pinned feedback-state Node modules from the same protected `origin/main` object
used for checklist policy, never from a PR-selected base, current head, or
selected commit. It runs that immutable entry point directly from the repo root;
it does not invoke branch-controlled package scripts or pnpm. The ledger's PR
number, base, head branch, and head object ID are revalidated before
publication. Git metadata reads discard caller-selected routing such as
`GIT_CONFIG`, `GIT_DIR`, and `GIT_WORK_TREE`; GitHub reads similarly discard
`GH_HOST` and `GH_REPO`. Missing GitHub CLI, zero or multiple PR matches, and malformed
metadata fail closed when `--feedback-pr auto` was explicitly requested. An
explicit `--base` or commit-mode target requires an explicit `--feedback-pr`
number rather than `auto`. The removed `--parallel-tests` mode must not be
reintroduced;
`pnpm agent:quality-gate --run` owns test execution and isolation.

For a real review, branch and commit targets are frozen to one object ID before
capture. Direct `--dry-run` reports the requested ref without resolving or
freezing it. The helper fingerprints symbolic-branch or detached identity plus
the selected `HEAD` and tracked worktree source. Untracked file and symlink
state is included only when local working-tree content belongs to the selected
target (`local` or branch-local); explicit branch and commit source snapshots
exclude unrelated untracked files. A lightweight `HEAD`/branch/status
fingerprint brackets target selection first, so a concurrent checkout or
clean-to-dirty transition fails closed without reading untracked file contents.
After target selection, explicit branch and commit reviews rely on the
target-scoped fingerprint and ignore unrelated untracked churn; automatic mode
retains the status guard because its target class depends on clean/dirty state.
For explicit branch and commit bundles in the owning checkout, the shell
adapter's bytes and executable mode must match frozen `HEAD`. The shell, MJS
helper, and core at frozen `HEAD` must also match the pinned protected-main
object in every target mode. Commit mode additionally compares the selected
commit with that protected baseline. The adapter executes MJS files
materialized from protected main, never from a PR-selected base or mutable
worktree. Local and branch-local bundles also require helper/core worktree bytes
to match frozen `HEAD`. Runtime changes fail closed for review from a separate
trusted checkout with an explicit compatible helper. Direct default-helper
execution in the owning checkout applies the same protected-main runtime pin.
Wrapper-owned Node launches discard `NODE_OPTIONS` and `NODE_PATH` before
executable probing, validation helpers, or the pinned MJS entry point can run;
dynamic-loader and interpreter startup-injection variables are scrubbed as
well. An explicit external helper remains caller-trusted. These checks protect
review integrity but are not a
provenance boundary: invoking the repo command already trusts executable code
in the active checkout. The adapter compares the target-scoped
fingerprint around prepared-bundle staging, so a same-commit branch switch,
moving base ref, or relevant concurrent edit fails closed instead of mixing
review snapshots. Its executable search path excludes the reviewed worktree,
requires the physical checkout root to match Git's top level, uses the system
path for bare shell utilities, and resolves Git, Node, GitHub CLI, and
semantic-engine executables to external targets before use. Direct targets and
every canonical ancestor must be owned by the current user or root and must not
be group/other-writable. On Darwin, Homebrew-style paths that fail only the
ancestry rule are
accepted through sealed private snapshots only when they are native Mach-O
executables with an entirely system-only linked-library closure; scripts and
relative or non-system library closure fail closed. Node discovery never
executes a version-manager shim: Volta is queried through a sealed native
`volta which node`, and the returned Node path is revalidated before launch.
Git commands ignore inherited repository-routing variables.

When no `--base` is supplied, automatic PR-base lookup falls back to
`origin/main` only after a confirmed zero-match result or when GitHub CLI is
absent. Malformed output, ambiguous multiple matches, and operational failures
fail closed. With GitHub CLI available, lookup requires a canonical
`github.com` origin, ignores inherited `GH_HOST` and `GH_REPO`, and explicitly
addresses that origin repository. A unique match must also belong to the
current repository owner, so a fork PR with the same branch name cannot select
the review base. Use an explicit `--base` when GitHub lookup is unavailable or
intentionally bypassed.

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
