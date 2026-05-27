---
name: deploy-indexer
description: Agent-native Envio indexer deploy orchestrator. Pushes the current branch HEAD to the `envio` branch, watches build and sync, optionally promotes to prod, waits for endpoint switchover, and verifies monitoring.mento.org. Use `--no-promote` to pre-load a feature branch's indexer changes ahead of merging. Triggers on "deploy indexer", "ship indexer", "push to envio", "pre-deploy indexer", or `/deploy-indexer`. Do NOT use for code-only PR ships — use `/ship` for that.
title: Deploy Indexer Skill
status: active
owner: eng
canonical: true
last_verified: 2026-05-20
---

# Deploy Indexer (end-to-end)

Push a commit to the `envio` branch, watch the build + re-index, promote to
prod, wait for the static URL to flip, then verify the dashboard.

Target commit: `HEAD` of the current working directory. The user's request may
contain the boolean flags `--no-promote` and/or `--no-verify` (see below); it does NOT
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

- `git fetch origin` and `git rev-parse --abbrev-ref HEAD` — capture as `BRANCH`. If `BRANCH == "HEAD"` the working tree is detached (the documented `git checkout <sha>` flow); skip the upstream/divergence checks below and instead verify the SHA is reachable from `origin`: `git merge-base --is-ancestor HEAD origin/main || git for-each-ref --contains HEAD refs/remotes/origin/ | grep -q .`. If that fails, the commit was never pushed — surface and stop. If `BRANCH` is a regular branch, run the upstream/divergence checks below; `main` is the common case but feature branches are fine for pre-merge deploys.
- `git status --porcelain` — must be empty. A dirty tree means uncommitted work; deploying it would ship a commit that doesn't exist on origin. Surface and stop.
- (Branch-mode only) Verify the branch tracks an upstream: `git rev-parse --abbrev-ref --symbolic-full-name @{upstream}` must succeed (and `git ls-remote --exit-code origin "$BRANCH"` must find the remote ref). A local-only branch with no upstream is not a valid deploy source — its `HEAD` was never pushed to `origin`, so the deploy would ship unreproducible code. Surface and stop; tell the user to `git push -u origin <branch>` first.
- (Branch-mode only) `git rev-list --left-right --count @{upstream}...HEAD` — both counts MUST be `0`. The right count (ahead) catches local commits that would silently ship via `envio` without ever landing on the tracked branch; the left count (behind) catches a stale local checkout that would deploy an outdated commit. If either is non-zero, surface the divergence and stop — the user must `git pull --rebase` (behind) or `git push` (ahead) first.
- Parse the user's arguments for the boolean flags `--no-promote` and `--no-verify`; capture as `NO_PROMOTE` and `NO_VERIFY`. Any non-flag token (e.g. a stray SHA) is an error — surface and stop, since the underlying script doesn't accept one.
- `git rev-parse --short=7 HEAD` — capture as `TARGET_COMMIT`. **Use `--short=7` explicitly**, not bare `--short`: Envio's API stores `commit_hash` truncated to exactly 7 chars, and `startswith(target)` matches on that — an 8-char short SHA (which is what `git rev-parse --short` returns once a repo's `core.abbrev` ticks up past 7) silently matches zero rows in the babysit + promote-verify queries. The deploy always uses `HEAD`; to deploy a different commit, the user must check it out first.
- If `BRANCH != main`: **default `NO_PROMOTE=true`** (fail-closed), and surface the branch name + commit short sha clearly. Override the default only when the user's request explicitly says "promote" / "go live" / similar — never on a bare `/deploy-indexer` from a feature branch. The reasoning: pre-merge deploys exist precisely because the dashboard codebase doesn't yet query the new schema; promoting before merge is almost always wrong, so make it explicit-opt-in instead of confirm-to-skip.

If preflight fails, surface the specific cause and stop. Do not push.

### Argument flags

The request MAY contain these flags (in any order):

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

Two sub-phases. Don't collapse them: registration confirms Envio's webhook +
build pipeline reacted to the push; sync confirms the running deployment caught
up to chain head. They fail for different reasons and want different responses.

### Phase 2a — Confirm registration (5 min hard ceiling, do not background blind)

Normal registration completes 2-3 min after the `envio` push. If the deployment
hasn't appeared in Envio's API by ~5 min, **the webhook is almost always broken
on Envio's side** (their app missed the push event, their build queue is jammed,
or — the silent failure mode — `pnpm deploy:indexer` no-op'd because the deploy
branch was already at HEAD). Waiting longer rarely recovers; investigate now.

Run the registration probe in the **foreground** with a tight ceiling:

```bash
ENVIO_REGISTRATION_TIMEOUT_SECONDS=300 pnpm deploy:indexer:status <TARGET_COMMIT> --watch
```

The status wrapper's default ceiling is 10 min; override to 5 min here so the
skill doesn't tie itself to the wrapper's safety net. The wrapper emits a
diagnostic warn at 3 min that surfaces the most likely causes inline.

**If you must background this** (e.g. you're handing off to a Monitor),
either (a) re-export the same low ceiling, or (b) checkpoint the output file
yourself at the 5-min mark — do NOT trust the wrapper's worst-case 10-min
default to give up "soon enough." Silent 10-min waits look identical to
"the build is just slow" until they aren't.

If registration succeeds, the wrapper transitions automatically into Phase 2b
(sync watching). If it fails, stop and follow the diagnostic the wrapper
already printed: check [the Envio dashboard](https://envio.dev/app/mento-protocol/mento), confirm
the `envio` branch on GitHub actually moved, and surface to the user before
re-pushing.

### Phase 2b — Wait for sync to catch up (90 min hard ceiling)

Once registered, the wrapper polls every 10 s and exits 0 when all chains
report caught-up. Foreground is fine here; the noisy progress table is the
work product.

Watch sync in the active rollout/session and do not leave a background process
running when you finish.

The Envio Cloud deployment id is the short Git commit hash (for example
`b92ff93b`). Once the deployment is registered, this id stays stable.

Do **not** use `pnpm deploy:indexer:logs` without a commit while babysitting a
new deployment. The no-commit form reads the latest visible deployment from
Envio, which can still be the old prod deployment during the registration phase
or after a failed build. Always pass the explicit target:

```bash
pnpm deploy:indexer:logs <TARGET_COMMIT> --build
pnpm deploy:indexer:logs <TARGET_COMMIT> --level error,warn --since 2h
```

Treat a successful caught-up exit as `READY_TO_PROMOTE`. If the command exits
non-zero, the deployment never registers within 5-10 min, or full sync is not
reached within 90 minutes, stop and surface the failure. **Never promote a
non-synced deployment.**

If the target is already in `prod_status=prod`, treat it as `ALREADY_PROMOTED`
and continue through the DNS wait + verify path for idempotency.

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
  | jq -r --arg target "<TARGET_COMMIT>" '
      [.data.deployments[]
       | select(.prod_status=="prod")
       | select((.commit_hash | startswith($target)) | not)]
      | sort_by(.created_time) | reverse | .[0].commit_hash // empty' \
  | head -c 7)
```

The `sort_by(.created_time) | reverse` step is load-bearing: the
`envio-cloud` API doesn't guarantee deployment order, so an unsorted
`head -n1` could pick an older prod entry from a long-ago deploy instead
of the immediately-prior one. Mirroring what `scripts/deploy-indexer-promote.sh`
does for "auto-detect latest deployment".

The `select(... | not)` clause excludes `TARGET_COMMIT` itself, which matters
on the idempotent re-run path: if you re-run `/deploy-indexer` for a commit
that's already `prod_status=prod`, the unfiltered query would return the
same SHA and the final summary's "rollback command" would point at the
commit just deployed — useless during an incident. Excluding the target
gives you the previous prod commit, which is what rollback actually needs.

If no prior prod commit exists (first-ever promote, or only the current
target is in prod), `PREVIOUS_PROD_COMMIT` is empty — the rollback line in
the final summary then reads "(none — no prior prod deploy, no rollback
target)".

Then promote:

```bash
pnpm deploy:indexer:promote <TARGET_COMMIT> -y
```

The wrapper resolves a full SHA to Envio's registered short deployment id and
passes remaining flags through to `envio-cloud deployment promote`, so `-y`
reaches the underlying CLI cleanly. Using the wrapper keeps org/indexer
defaults centralized.

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

Wait **5 minutes wall-clock**, then proceed. Run a one-shot sleep and wait for
it to finish before continuing to Phase 5:

```bash
sleep 300 && echo "dns-window-elapsed"
```

Until the sleep exits, do NOT start UI verification and do NOT poll the static
URL. Skipping the DNS-flip window produces flaky verify results, which is
exactly the failure mode the wait exists to prevent.

Don't poll the static URL with introspection — Envio's edge cache flips
opaquely; absence of an introspectable schema change just means our PR didn't
add new GraphQL fields, not that the routing hasn't flipped. If you have a
strong signal in this PR's diff (a new entity / field in `schema.graphql`),
you MAY query for it as a probe; otherwise just wait 5 min and move on.

## Phase 5 — Verify the UI

If `--no-verify` was passed, stop here and print the final summary.

Otherwise verify with chrome-devtools MCP directly, following the browser
verification protocol in `AGENTS.md`. Use the target URL plus a focus hint for
the data the new deployment touches:

- The target URL: `https://monitoring.mento.org`
- A focus hint pointing at the data the new deployment touches. Examples:
  - For a contracts bump that added a bridge token: "verify CHFm + JPYm bridge transfers render on `/bridge-flows`"
  - For a schema/entity addition: "verify the new `<entity>` field renders on `/<page>`"
  - For a pure backfill (no schema change): "smoke-test homepage / pools / bridge-flows for regressions; no new fields to verify"

If chrome-devtools MCP is unavailable, surface that and stop — do not ask the
user to verify manually.

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
- **Pass the resolved short SHA explicitly** to status and verification steps — don't rely on "latest", since a concurrent deploy by someone else could shift it.
- **Don't open a PR** to verify the deploy. This skill is a plumbing chain, not a code-review path. The PR (if any) was merged before this skill ran; the deploy is a separate concern.
- **Default to `--no-promote` when deploying from a non-`main` branch** unless the user explicitly asked to promote. Promoting a feature-branch schema before its dashboard code is live in production wastes a sync (you'd re-promote on merge) and creates an ambiguous rollback target.
