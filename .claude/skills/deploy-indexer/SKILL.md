---
name: deploy-indexer
description: End-to-end Envio indexer deploy orchestrator. Pushes the current branch HEAD (typically `main`, but any branch is supported for pre-merge deploys) to the `envio` branch, babysits the build + sync via `babysit-indexer-deploy`, optionally promotes to prod, waits for DNS switchover, and runs `verify-ui` against monitoring.mento.org. Use `--no-promote` to pre-load a feature branch's indexer changes ahead of merging. Triggers on "deploy indexer", "ship indexer", "push to envio", "pre-deploy indexer", or `/deploy-indexer`. Do NOT use for code-only PR ships — use `/ship` for that.
allowed-tools: Bash, Read, Skill
argument-hint: [--no-promote] [--no-verify]
---

# Deploy Indexer (end-to-end)

Push a commit to the `envio` branch, watch the build + re-index, promote to
prod, wait for the static URL to flip, then verify the dashboard.

Target commit: `HEAD` of the current working directory. `$ARGUMENTS` may contain
the boolean flags `--no-promote` and/or `--no-verify` (see below); it does NOT
take a commit SHA — the underlying `pnpm deploy:indexer` script always pushes
`HEAD`, so to deploy a different commit, check it out first.

## Why pre-merge deploys exist

The default flow is "merge PR → deploy from main". For an indexer change with
a fresh schema or new event coverage, the dashboard's new UI starts depending
on the new schema/data the moment the PR merges — but the indexer takes
~30–60 min to build + re-sync from `start_block`. During that window the UI
queries the OLD indexer (still in `prod`) for fields that don't yet exist,
breaking pages until the new deployment is promoted.

To avoid that gap, this skill supports **pre-merge deploys** from any branch:
push a feature branch to `envio` ahead of merging, let the indexer sync to
caught-up while review is still happening, and the moment the PR lands the
data is already live. The `envio` branch is just a deploy trigger — it does
not have to track `main`.

When deploying pre-merge, you typically want to NOT promote yet (the PR
isn't merged; the new schema isn't live in the codebase). Pass `--no-promote`
to stop after sync; promote separately once the PR merges.

## Phase 0 — Preflight

Run from the **main checkout** or whatever local checkout is on the branch
you want to deploy. The `pnpm deploy:indexer` script reads `HEAD` of the
current working directory and pushes that commit to `envio`. If you're in a
worktree on the feature branch, deploy from there directly — no need to
switch to the main checkout.

In parallel:

- `git fetch origin` and `git rev-parse --abbrev-ref HEAD` — capture as `BRANCH`. Any branch is allowed; `main` is the common case but feature branches are fine for pre-merge deploys.
- `git status --porcelain` — must be empty. A dirty tree means uncommitted work; deploying it would ship a commit that doesn't exist on origin. Surface and stop.
- Verify the branch tracks an upstream: `git rev-parse --abbrev-ref --symbolic-full-name @{upstream}` must succeed (and `git ls-remote --exit-code origin "$BRANCH"` must find the remote ref). A local-only branch with no upstream is not a valid deploy source — its `HEAD` was never pushed to `origin`, so the deploy would ship unreproducible code. Surface and stop; tell the user to `git push -u origin <branch>` first.
- `git rev-list --left-right --count @{upstream}...HEAD` — both counts MUST be `0`. The right count (ahead) catches local commits that would silently ship via `envio` without ever landing on the tracked branch; the left count (behind) catches a stale local checkout that would deploy an outdated commit. If either is non-zero, surface the divergence and stop — the user must `git pull --rebase` (behind) or `git push` (ahead) first.
- Parse `$ARGUMENTS` for the boolean flags `--no-promote` and `--no-verify`; capture as `NO_PROMOTE` and `NO_VERIFY`. Any non-flag token (e.g. a stray SHA) is an error — surface and stop, since the underlying script doesn't accept one.
- `git rev-parse --short HEAD` — capture as `TARGET_COMMIT`. The deploy always uses `HEAD`; to deploy a different commit, the user must check it out first.
- If `BRANCH != main`: **default `NO_PROMOTE=true`** (fail-closed), and surface the branch name + commit short sha clearly. Override the default only when the user's request explicitly says "promote" / "go live" / similar — never on a bare `/deploy-indexer` from a feature branch. The reasoning: pre-merge deploys exist precisely because the dashboard codebase doesn't yet query the new schema; promoting before merge is almost always wrong, so make it explicit-opt-in instead of confirm-to-skip.

If preflight fails, surface the specific cause and stop. Do not push.

### Argument flags

The `$ARGUMENTS` string MAY contain (in any order, space-separated):

- `--no-promote` — push + sync, but skip Phase 3 (promote) and everything after. Use for pre-merge deploys where the new schema isn't live in the codebase yet. Promote separately with `npx envio-cloud deployment promote mento <commit> mento-protocol -y` once the PR merges.
- `--no-verify` — skip Phase 5. Use when you want the deploy + DNS wait to complete unattended.

The deployed commit is always the current `HEAD` — there's no SHA argument. To
deploy a specific older commit, `git checkout <sha>` first, then run the skill.

Examples:

- `/deploy-indexer` — deploy current `HEAD` (most often `main`), full pipeline through verify.
- `/deploy-indexer --no-promote` — deploy current branch, sync, stop. The default for most pre-merge feature-branch deploys.
- `/deploy-indexer --no-promote --no-verify` — pre-merge deploy that runs unattended (e.g. you're stepping away during the build).

## Phase 1 — Push to `envio`

```bash
pnpm deploy:indexer --yes
```

The script pushes `HEAD` to the `envio` branch via `git push
--force-with-lease`, which the Envio GitHub App auto-builds. The push is
unconditional — `envio` is treated as a deploy trigger ref, not a tracking
branch, so a feature branch tip can replace whatever was on `envio`
previously. Confirm the push succeeded by checking the script exit code is
`0`. The push output is one of:

- A ref-update line `<old>..<new>  HEAD -> envio` (fast-forward) or `+ <old>...<new>  HEAD -> envio` (forced update) — a real deploy was scheduled.
- `Everything up-to-date` with no ref-update line — `envio` already at `HEAD`, the re-run / idempotency case. Still success; the prior deployment in `envio-cloud` is what we're babysitting.

If the push was rejected (non-zero exit, "rejected", "stale info", "would
clobber existing tag"), do NOT retry with `--force` — surface and stop.

When the previous `envio` tip was a different branch's commit (e.g. you're
overwriting a still-syncing prior deploy), the prior deployment continues
to exist in `envio-cloud` and stays available for promote. The new push just
schedules a fresh build; nothing destructive happens to the running indexer
or the deployment record list.

## Phase 2 — Babysit the build + sync

Invoke `babysit-indexer-deploy` via the Skill tool with `args: "<TARGET_COMMIT>"`.
That skill handles its own poll loop (5m cron, 18-cycle / 90-min budget) and
returns when:

- All chains' `timestamp_caught_up_to_head_or_endblock` is non-empty (success), OR
- 30 min elapsed without the deployment registering (build failed; stop), OR
- 90 min elapsed without full sync (stop and report last status), OR
- The user cancels.

Do NOT poll status yourself in parallel — the skill is the single source of
truth for sync state. Wait for it to return before continuing.

Babysit returns one of:

- **"ready to promote"** — the new deployment is synced; continue to Phase 3.
- **"already promoted"** — `TARGET_COMMIT` is already `prod_status=prod` (re-run case); continue to Phase 3, which will be a no-op, then through DNS wait + verify per the idempotency contract.
- Anything else (build failed, sync stalled, user cancelled) — stop and surface the failure. **Never promote a non-synced deployment.**

**If `--no-promote` was passed, stop here.** Print a summary listing the
synced commit and the paste-ready promote command for the user to run later
(typically right after the PR merges):

```text
Pre-merge deploy complete. Commit <TARGET_COMMIT> is fully synced and ready.
Promote when the PR lands with:
  npx envio-cloud deployment promote mento <TARGET_COMMIT> mento-protocol -y
```

Do NOT continue to Phase 3 / 4 / 5. The new schema isn't live in the
dashboard codebase yet, so promoting now would point the static URL at a
schema the deployed UI doesn't query — no harm, but also no benefit, and it
makes the rollback story muddier.

## Phase 3 — Promote

Before promoting, capture the **current** prod commit so the final summary
can print a paste-ready rollback command:

```bash
PREVIOUS_PROD_COMMIT=$(npx envio-cloud indexer get mento mento-protocol -o json \
  | jq -r '.data.deployments[] | select(.prod_status=="prod") | .commit_hash' \
  | head -c 7)
```

If no prior prod commit exists (first-ever promote), `PREVIOUS_PROD_COMMIT`
is empty — the rollback line in the final summary then reads "(none — first
prod deploy, no rollback target)".

Then promote:

```bash
pnpm deploy:indexer:promote <TARGET_COMMIT> -y
```

The wrapper passes `"$@"` through to `npx envio-cloud deployment promote`
(see `scripts/deploy-indexer-promote.sh`), so `-y` reaches the underlying
CLI cleanly. Using the wrapper keeps org/indexer defaults centralized.

Confirm the response line `Deployment '<commit>' of indexer 'mento' promoted to production successfully.` Then verify with:

```bash
npx envio-cloud indexer get mento mento-protocol -o json \
  | jq -r '.data.deployments[] | select(.commit_hash | startswith("<TARGET_COMMIT>")) | "prod_status=\(.prod_status)"'
```

`prod_status=prod` is the success signal.

## Phase 4 — Wait for static URL switchover

The static GraphQL endpoint (e.g. `https://indexer.hyperindex.xyz/60ff18c/v1/graphql`)
takes ~30 s – a few minutes to flip to the newly promoted deployment. During
that window the dashboard may transiently query the old schema.

Wait **5 minutes wall-clock**, then proceed. Start a one-shot sleep with
`run_in_background: true` and **wait for the system completion notification
before continuing to Phase 5**:

```bash
sleep 300 && echo "dns-window-elapsed"
```

The Bash tool returns immediately with a shell ID; the harness fires a
notification when the sleep exits. Until that notification arrives, do NOT
start `verify-ui`, do NOT check on the shell, and do NOT poll the static URL
— just wait. A backgrounded sleep that you don't wait on silently skips the
DNS-flip window and produces flaky verify results, which is exactly the
failure mode the wait exists to prevent.

Don't poll the static URL with introspection — Envio's edge cache flips
opaquely; absence of an introspectable schema change just means our PR didn't
add new GraphQL fields, not that the routing hasn't flipped. If you have a
strong signal in this PR's diff (a new entity / field in `schema.graphql`),
you MAY query for it as a probe; otherwise just wait 5 min and move on.

## Phase 5 — Verify the UI

If `--no-verify` was passed, stop here and print the final summary.

Otherwise invoke `verify-ui` via the Skill tool. Pass an `args` string that includes:

- The target URL: `https://monitoring.mento.org`
- A focus hint pointing at the data the new deployment touches. Examples:
  - For a contracts bump that added a bridge token: "verify CHFm + JPYm bridge transfers render on `/bridge-flows`"
  - For a schema/entity addition: "verify the new `<entity>` field renders on `/<page>`"
  - For a pure backfill (no schema change): "smoke-test homepage / pools / bridge-flows for regressions; no new fields to verify"

The verify skill runs chrome-devtools MCP itself; do not arm a separate
browser session. If chrome-devtools MCP is unavailable, surface that and
stop — do not ask the user to verify manually.

## Final summary (always print)

- **Deployed commit:** `<TARGET_COMMIT>`
- **Build + sync:** time-to-caught-up (mm:ss), per-chain final blocks
- **Promote:** ✅ / ❌ (and `PREVIOUS_PROD_COMMIT` captured in Phase 3, for rollback reference)
- **DNS wait:** 5 min completed
- **UI verify:** pages checked + console errors found (✅ if none)
- **Rollback command (paste-ready):** `pnpm deploy:indexer:promote <PREVIOUS_PROD_COMMIT> -y` — or "(none — first prod deploy)" if `PREVIOUS_PROD_COMMIT` was empty.

## Failure handling

- **Preflight fails** (dirty tree / wrong branch / unpushed commits) → stop. Do not auto-clean; the user owns that state.
- **Push to envio fails** → stop; never force-push.
- **Build doesn't register in 30 min** → stop; suggest `pnpm deploy:indexer:logs --build`.
- **Sync stalls past 90 min** → stop; report last status. Don't promote.
- **Promote fails** → stop; the previous deployment is still serving. Surface the error.
- **DNS wait interrupted** (user cancels) → stop; do not skip to verify.
- **Verify UI finds errors** → surface them with file/line, ask the user whether to roll back. Don't auto-rollback — promote-to-prior is destructive.

## Idempotency

Re-running `/deploy-indexer` for a commit that's already `prod_status=prod`:

- Preflight will pass.
- Push is a no-op (envio already at that commit).
- Babysit returns immediately ("already promoted").
- Promote is a no-op (already prod).
- DNS wait still fires the 5-min sleep.
- Verify still runs.

That's fine — costs ~5 min and re-confirms the dashboard is live. Do not
short-circuit; the verification is the value on a re-run.

## Common pre-merge workflow

1. You're working on a feature branch with both indexer changes (new schema entity, new event coverage, new field) and dashboard changes that consume them.
2. Before opening the PR (or while it's in review), run `/deploy-indexer --no-promote` from the feature branch checkout — pushes the branch tip to `envio`, builds, syncs to caught-up. ~30–60 min.
3. The PR review proceeds normally. The new deployment exists in `envio-cloud` but isn't `prod` yet, so the live dashboard keeps querying the old indexer.
4. PR merges to `main`. Now run `/deploy-indexer` (without `--no-promote`) from `main` — preflight passes, push is fast (or a no-op if `envio` is already at the commit you're about to push, i.e. SHA-identical to step 2's tip), babysit returns immediately ("already promoted"), promote flips `prod`, DNS waits 5 min, verify passes. The new schema goes live without the usual 30–60 min indexer-lag window.
5. The fast path in step 4 only holds when the commit you push from `main` is byte-identical to what was already on `envio`. Squash-merge produces a new SHA, so the prior `envio` tip becomes irrelevant and you eat a fresh build + sync. To preserve commit identity through merge: use a merge commit or rebase-merge for branches that were pre-deployed, OR pre-deploy from the merge-base just before merging so the eventual `main` tip matches.

## Rules

- **Never manually force-push** to `main` or any tracked branch. The `pnpm deploy:indexer` script's `--force-with-lease` push to `envio` is the one sanctioned exception (and `envio` is a deploy-trigger ref, not a tracking branch); any other force-push is off-limits.
- **Never auto-rollback.** Promote-to-prior is the user's call.
- **Never bypass the babysit phase** — don't promote based on a single status snapshot.
- **Always wait the full 5 min** for DNS switchover before verifying — bypassing produces flaky verify results.
- **Pass the resolved short SHA explicitly** to `babysit-indexer-deploy` and `verify-ui` — don't rely on those skills auto-resolving "latest", since a concurrent deploy by someone else could shift it.
- **Don't open a PR** to verify the deploy. This skill is a plumbing chain, not a code-review path. The PR (if any) was merged before this skill ran; the deploy is a separate concern.
- **Default to `--no-promote` when deploying from a non-`main` branch** unless the user explicitly asked to promote. Promoting a feature-branch schema before its dashboard code is live in production wastes a sync (you'd re-promote on merge) and creates an ambiguous rollback target.
