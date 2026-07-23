---
name: deploy-indexer
description: Agent-native Envio indexer deploy orchestrator. Pushes the current branch HEAD to the `envio` branch, watches build and sync, verifies deployment health, optionally promotes to prod, waits for endpoint switchover, and verifies monitoring.mento.org. Use `--no-promote` to pre-load a feature branch's indexer changes ahead of merging. Triggers on "deploy indexer", "ship indexer", "push to envio", "pre-deploy indexer", or `/deploy-indexer`. Do NOT use for code-only PR ships — use `/ship` for that.
title: Deploy Indexer Skill
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
doc_type: skill
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# Deploy Indexer (end-to-end)

Push a commit to the `envio` branch, watch the build + re-index, verify
deployment health, optionally promote an explicitly authorized production
deploy, wait for the static URL to flip, then verify the dashboard. Read
`docs/deployment.md` first; it owns the canonical deploy and rollback policy.

In a normal deploy, the target commit is `HEAD` of the current working
directory. The user's request may contain `--no-promote`, `--no-verify`, or
the post-merge continuation `--resume-preload <commit>` (see below). Only that
continuation accepts a commit SHA: it never pushes, and it finishes the
existing candidate through Phase 6 unless `--no-verify` explicitly skips the
browser step. The underlying `pnpm deploy:indexer` script always pushes `HEAD`,
so check out a different commit before a normal deploy.

## Why pre-merge deploys exist

The default flow is "merge PR → deploy from main". For an indexer change with
a fresh schema or new event coverage, the dashboard's new UI starts depending
on the new schema/data as soon as the matching production dashboard deployment
serves traffic — but a full re-index from `start_block` can outlast the
dashboard rollout. During that window the new UI can query the old indexer (still
in `prod`) for fields that don't yet exist, breaking pages until the new
deployment is promoted.

To avoid that gap, this skill supports **pre-merge deploys** from any branch:
push a feature branch to `envio` ahead of merging and let it sync while review
is still happening. After merge it is ready for the verification/promotion
decision. The `envio` branch is a deploy trigger, not a mirror of `main`.

When deploying pre-merge, pass `--no-promote`: the reviewed code is not on
`main` yet. After merge, an additive preloaded deployment may be promoted only
if its `indexer-envio/` tree still matches protected `main` in
`mento-protocol/monitoring-monorepo`. Removals or renames require a
backward-compatible two-phase rollout or an explicit cutover/rollback plan.

## Phase 0 — Preflight

For a normal deploy, run from the checkout whose `HEAD` you want to push. For a
resume, use any clean checkout that contains the recorded preload commit; the
resume validates that candidate against the canonical repository's protected
`main` and never pushes.

In parallel:

- Parse `--no-promote`, `--no-verify`, and the optional pair
  `--resume-preload <commit>` into `NO_PROMOTE`, `NO_VERIFY`, and
  `RESUME_PRELOAD`. Reject every other token and reject combining a resume
  with `--no-promote`: a resume exists only to finish the post-merge pipeline.
- `git status --porcelain` — must be empty. A dirty tree means uncommitted work; deploying it would ship a commit that doesn't exist on origin. Surface and stop.
- Resolve `CANONICAL_REMOTE` from `git remote -v`, then verify its repository is
  exactly `mento-protocol/monitoring-monorepo` before trusting it:
  ```bash
  gh repo view "$(git remote get-url "$CANONICAL_REMOTE")" --json nameWithOwner --jq .nameWithOwner
  git fetch "$CANONICAL_REMOTE" main:refs/remotes/"$CANONICAL_REMOTE"/main
  ```
  Capture that fetched ref as `CANONICAL_MAIN_REF`. Stop if no verified remote
  exists. In any Claude cloud session skip the `gh repo view` check — the
  remote is the credential-proxy URL, which gh cannot map to a repository
  even when the capability gate passes
  ([`docs/notes/github-tooling-surfaces.md`](../../../docs/notes/github-tooling-surfaces.md));
  verify by content: the remote URL's repository path must end in
  `mento-protocol/monitoring-monorepo` (the git credential proxy embeds the
  attached repo slug) and the `git fetch` above must succeed — otherwise stop
  and hand the deploy to a gh-capable surface. This check does not waive the
  `CANONICAL_REMOTE=origin` requirement. In normal mode, require
  `CANONICAL_REMOTE=origin` because the deploy
  wrapper pushes `origin/envio`; a fork `origin` cannot trigger the canonical
  Envio deployment.
- In normal mode, `git rev-parse --abbrev-ref HEAD` supplies `BRANCH`. A
  detached `HEAD` must be reachable from the canonical repository; a branch
  must have a canonical remote ref/upstream, and
  `git rev-list --left-right --count @{upstream}...HEAD` must return `0 0`.
  Otherwise the source is stale or unreproducible: stop before pushing.
- In normal mode, query the registry with the pinned `envio-cloud` binary and
  count `data.deployments[]` before pushing:
  ```bash
  pnpm exec envio-cloud indexer get mento mento-protocol -o json
  ```
  At the current three-deployment limit, retain prod and remove—or ask the user
  to remove—an obsolete non-prod deployment before creating another.
- In normal mode, `git rev-parse HEAD` supplies the full `TARGET_COMMIT`. In
  resume mode, resolve the supplied commit to a full SHA and compare its
  `indexer-envio/` tree with the freshly fetched canonical main ref:
  ```bash
  git diff --quiet "$TARGET_COMMIT" "$CANONICAL_MAIN_REF" -- indexer-envio
  ```
  If the candidate is unavailable or its indexer tree differs, stop and deploy
  the current `main` commit through the normal full pipeline.
  Skip Phase 1 in resume mode; Phase 2 must still reconfirm that the registered
  candidate is caught up before Phase 3.
- Use `git rev-parse --short=7 "$TARGET_COMMIT"` only as `TARGET_DISPLAY`:
  seven is a minimum, not a guaranteed output width. The wrappers resolve full
  SHAs against Envio's stored commit prefix; raw queries must test whether the
  full SHA starts with the stored prefix, never the reverse.
- In normal mode, if `BRANCH != main`, default `NO_PROMOTE=true` (fail-closed)
  and surface the branch plus `TARGET_DISPLAY`. Override only when the user
  explicitly authorized promotion. A resume also requires explicit production
  authorization; the flag itself is not approval.

If preflight fails, surface the specific cause and stop. Do not push. A request
to monitor, preload, or report readiness never authorizes promotion; only an
explicit end-to-end production deploy request does.

### Argument flags

The request MAY contain these flags (in any order):

- `--no-promote` — push + sync, then stop. After merge, an additive preload
  may proceed only when its `indexer-envio/` tree matches canonical protected
  `main`;
  removals/renames still require the approved compatibility or cutover plan.
- `--no-verify` — skip Phase 6 browser/UI verification. Use when you want the deploy + endpoint-propagation wait to complete unattended.
- `--resume-preload <commit>` — after merge, reuse an already-synced candidate
  whose `indexer-envio/` tree exactly matches freshly fetched canonical `main`.
  Skip the push, reconfirm sync, then execute every remaining gate in Phases
  3–6. This flag does not itself authorize promotion; the request must
  explicitly authorize the end-to-end production continuation.

Outside `--resume-preload`, the deployed commit is always the current `HEAD`.
To deploy a specific older commit normally, `git checkout <sha>` first.

Examples:

- `/deploy-indexer` — deploy current `HEAD` (most often `main`), full pipeline through verify.
- `/deploy-indexer --no-promote` — deploy current branch, sync, stop. The default for most pre-merge feature-branch deploys.
- `/deploy-indexer --no-promote --no-verify` — pre-merge deploy that runs unattended (e.g. you're stepping away during the build).
- `/deploy-indexer --resume-preload <commit>` — after merge and explicit
  production authorization, finish the matching synced candidate through
  verification, promotion, propagation, and UI verification.

## Phase 1 — Push to `envio`

For `--resume-preload`, do not run this phase and do not move the `envio`
branch. Continue at Phase 2 with the resolved preloaded `TARGET_COMMIT`.

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
- `Everything up-to-date` with no ref-update line — the wrapper checks whether
  Envio already registered this SHA. It continues for a legitimate rerun and
  exits nonzero with a fresh-SHA retrigger procedure when the webhook missed
  the unchanged ref.

If the push was rejected (non-zero exit, "rejected", "stale info", "would
clobber existing tag"), do NOT retry with `--force` — surface and stop.

## Phase 2 — Babysit the build + sync

Two sub-phases. Don't collapse them: registration confirms Envio's webhook +
build pipeline reacted to the push; sync confirms the running deployment caught
up to chain head. They fail for different reasons and want different responses.

### Phase 2a — Confirm registration (5 min hard ceiling, do not background blind)

Normal registration completes 2-3 min after the `envio` push. If the deployment
hasn't appeared in Envio's API by ~5 min, check the active deployment count
first. **Three live deployments means Envio has no room to create another
deployment**; delete, or ask the user to delete, an obsolete non-prod deployment
before pushing a fresh SHA. If there are fewer than three deployments, then
treat the miss as an Envio-side webhook/build problem (their app missed the push
event, their build queue is jammed, or — the silent failure mode —
`pnpm deploy:indexer` no-op'd because the deploy branch was already at HEAD).
Waiting longer rarely recovers; investigate now.

Run the registration probe in the **foreground** with a tight ceiling:

```bash
ENVIO_REGISTRATION_TIMEOUT_SECONDS=300 pnpm deploy:indexer:status <TARGET_COMMIT> --watch --compact
```

The status wrapper's default ceiling is 10 min; override to 5 min here so the
skill doesn't tie itself to the wrapper's safety net. The wrapper emits a
diagnostic warn at 3 min that surfaces the most likely causes inline.
Use `--compact` for agent runs to emit low-noise one-line progress snapshots
instead of repainting the full status table every poll. For a human terminal,
drop `--compact` when the full per-poll table is useful.

If registration succeeds, the wrapper transitions automatically into Phase 2b
(sync watching). If it fails, stop and follow the diagnostic the wrapper
already printed: check [the Envio dashboard](https://envio.dev/app/mento-protocol/mento), confirm
the `envio` branch on GitHub actually moved, and surface to the user before
re-pushing.

### Phase 2b — Wait for sync to catch up (90 min hard ceiling)

Once registered, the wrapper polls every 10 s and exits 0 when all chains
report caught-up. In `--compact` mode it prints the first sample, stable sync
state changes, cadence checkpoints, and caught-up state while suppressing idle
volatile progress changes. Drop `--compact` only when the full per-poll table
is useful in a human terminal.

Watch sync in the active rollout/session and do not leave a background process
running when you finish. The wrapper has no 90-minute sync timeout; the agent or
monitor must enforce that wall-clock ceiling and interrupt the watch.

The Envio Cloud deployment id is the short Git commit hash (for example
`b92ff93b`). Once the deployment is registered, this id stays stable.

Do **not** use `pnpm deploy:indexer:logs` without a commit while babysitting a
new deployment. The no-commit form reads the latest visible deployment from
Envio, which can still be the old prod deployment during the registration phase
or after a failed build. Always pass the explicit target:

```bash
pnpm deploy:indexer:logs <TARGET_COMMIT> --build
pnpm deploy:indexer:logs <TARGET_COMMIT> --level error,warn --since 2h
pnpm deploy:indexer:perf <TARGET_COMMIT>
```

Capture the performance snapshot after sync and before verification so the
final report has a commit-scoped status/metrics/log record.

Treat a successful caught-up exit as `SYNCED_PENDING_DATA_VERIFY`, not
`READY_TO_PROMOTE`. If the command exits non-zero, the deployment does not
register within five minutes, or full sync is not reached within 90 minutes, stop
and surface the failure. **Never promote a non-synced deployment.**

If the target is already in `prod_status=prod`, treat it as `ALREADY_PROMOTED`
and continue through the endpoint-propagation wait + verify path for idempotency.

**If `--no-promote` was passed, stop here.** Print a summary listing the synced
commit and the guarded continuation for later use (typically right after the
PR merges for additive fields/entities; not for removals/renames until a
compatibility or cutover plan is confirmed):

```text
Pre-merge deploy complete. Commit <TARGET_COMMIT> is fully synced and pending deployment verification.
For additive fields/entities, continue only after merge with explicit production authorization:
  /deploy-indexer --resume-preload <TARGET_COMMIT>
That continuation must confirm indexer-envio tree equality, reconfirm sync, and execute Phases 3-6. Never run the promote wrapper as a shortcut.
For removals/renames, do not promote until compatibility or a coordinated cutover/rollback plan is confirmed.
```

Do NOT continue to Phase 3 / 4 / 5 / 6. The reviewed schema is not on `main`.

## Phase 3 — Verify deployment before promotion

Before any promotion path, classify rollout compatibility against the deployed
dashboard(s), not just the source branch:

- **Additive fields/entities/data only:** continue after merge; a preloaded
  candidate must also match the merged `indexer-envio/` tree.
- **Field/entity removals or renames consumed by old or new dashboard code:**
  stop unless the PR or user request already documents a
  backward-compatible/two-phase rollout, or an explicit coordinated
  cutover/rollback plan. If that plan is absent, surface the split-brain risk
  and ask for the rollout decision before running the promote command.
- **Pure backfill/no schema contract change:** continue after confirming the
  deployment is caught up; verify the affected dashboard pages after promote.

Run the narrow deployment verifier before promoting:

```bash
pnpm deploy:indexer:verify <TARGET_COMMIT>
```

This combines status, metrics, endpoint, core-row, and Polygon replay checks.
Do not promote on any failure. `--allow-syncing` is diagnostic only and never
waives data or replay-semantic failures. A missing replay marker or tainted
historical RPC replay requires a fresh deployment; `docs/deployment.md` owns
the exact verifier contract.

## Phase 4 — Promote

Before promoting, capture the **current** prod commit so the final summary
can print a paste-ready rollback command:

```bash
PREVIOUS_PROD_COMMIT=$(pnpm --silent exec envio-cloud indexer get mento mento-protocol -o json \
  | jq -r --arg full "<TARGET_COMMIT>" '
      [.data.deployments[]
       | select(.prod_status=="prod")
       | select(.commit_hash as $stored | ($full | startswith($stored) | not))]
      | sort_by(.created_time) | reverse | .[0].commit_hash // empty')
```

Sorting avoids API-order assumptions; the reverse prefix test handles Envio's
truncated ids and excludes the target. If no prior prod is discoverable, report
that no rollback target was captured instead of guessing.

Promote only when the request explicitly authorized the end-to-end production
deploy. Otherwise stop after verification and ask for approval to continue
this skill through Phases 4–6; do not surface the wrapper as a standalone
shortcut. Once authorized, run:

```bash
pnpm deploy:indexer:promote <TARGET_COMMIT> -y
```

The wrapper resolves a full SHA to Envio's registered short deployment id and
passes remaining flags through to `envio-cloud deployment promote`, so `-y`
reaches the underlying CLI cleanly. Using the wrapper keeps org/indexer
defaults centralized.

Require a zero wrapper exit, then verify with:

```bash
pnpm --silent exec envio-cloud indexer get mento mento-protocol -o json \
  | jq -r --arg full "<TARGET_COMMIT>" '.data.deployments[] | select(.commit_hash as $stored | $full | startswith($stored)) | "prod_status=\(.prod_status)"'
```

`prod_status=prod` is the success signal.

## Phase 5 — Wait for static endpoint propagation

The static GraphQL endpoint (e.g. `https://indexer.hyperindex.xyz/2f3dd15/v1/graphql`)
takes ~30 s – a few minutes to flip to the newly promoted deployment. During
that window the dashboard may transiently query the old schema.

Wait **5 minutes wall-clock**, then proceed. Run a one-shot sleep and wait for
it to finish before continuing to Phase 6:

```bash
sleep 300 && echo "endpoint-propagation-window-elapsed"
```

Until the sleep exits, do NOT start UI verification and do NOT poll the static
URL. Skipping the propagation window produces flaky verify results, which is
exactly the failure mode the wait exists to prevent.

Don't poll the static URL with introspection — Envio's edge cache flips
opaquely; absence of an introspectable schema change just means our PR didn't
add new GraphQL fields, not that the routing hasn't flipped. If you have a
strong signal in this PR's diff (a new entity / field in `schema.graphql`),
you MAY query for it as a probe; otherwise just wait 5 min and move on.

## Phase 6 — Verify the UI

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
- **Performance snapshot:** `pnpm deploy:indexer:perf <TARGET_COMMIT>` captured status/metrics/log highlights
- **Deployment verify:** `pnpm deploy:indexer:verify <TARGET_COMMIT>` passed before promotion
- **Promote:** ✅ / ❌ (and `PREVIOUS_PROD_COMMIT` captured in Phase 4, for rollback reference)
- **Endpoint propagation wait:** 5 min completed
- **UI verify:** pages checked + console errors found (✅ if none)
- **Rollback command (paste-ready):** `pnpm deploy:indexer:rollback <PREVIOUS_PROD_COMMIT>` — or "(none captured)" if `PREVIOUS_PROD_COMMIT` was empty.

## Failure handling

- **Preflight fails** (dirty tree / wrong branch / unpushed commits) → stop. Do not auto-clean; the user owns that state.
- **Push to envio fails** → stop; never force-push.
- **Build doesn't register in 5 min** → stop; check deployment capacity and
  the wrapper diagnostic. Do not use unscoped logs as proof of the target
  build.
- **Sync stalls past 90 min** → stop; report last status. Don't promote.
- **Deployment verification fails** → stop; do not promote until status, metrics, endpoint, core rows, and semantic replay checks pass. A tainted historical replay requires a fresh deployment, not another promotion attempt.
- **Promote fails** → stop; the previous deployment is still serving. Surface the error.
- **Endpoint propagation wait interrupted** (user cancels) → stop; do not skip to verify.
- **Verify UI finds errors** → surface them with file/line, ask the user whether to roll back. Don't auto-rollback — promote-to-prior is destructive.

## Idempotency

For a commit already in prod, the wrapper accepts the registered no-op push and
the status watch returns immediately. Still run deployment verification, the
five-minute propagation wait, and UI verification; those checks are the value
of the rerun.

## Common pre-merge workflow

1. From a feature branch with additive indexer changes, record
   `PRELOADED_COMMIT=$(git rev-parse HEAD)` and run
   `/deploy-indexer --no-promote`.
2. After the PR merges, resolve and fetch `CANONICAL_MAIN_REF` through the
   verified canonical remote from Phase 0, then run
   `git diff --quiet "$PRELOADED_COMMIT" "$CANONICAL_MAIN_REF" -- indexer-envio`.
3. If the trees match and the user explicitly authorizes the production
   continuation, run `/deploy-indexer --resume-preload "$PRELOADED_COMMIT"`.
   It skips only the push, reconfirms sync, then executes Phases 3–6—including
   prior-prod capture, promotion confirmation, propagation wait, UI verification,
   and the rollback-ready final summary. Merge, squash, and rebase strategies
   may all change the Git SHA; tree equality—not SHA identity—is the safety
   check.
4. If the trees differ, do not promote the stale preload. Deploy the current
   `main` commit and wait for its fresh build, sync, and verification.

## Rules

- **Never manually force-push** to `main` or any tracked branch. The `pnpm deploy:indexer` script's `--force-with-lease` push to `envio` is the one sanctioned exception (and `envio` is a deploy-trigger ref, not a tracking branch); any other force-push is off-limits.
- **Never auto-rollback.** Promote-to-prior is the user's call.
- **Never bypass the babysit phase** — don't promote based on a single status snapshot.
- **Never bypass the deployment verifier** — run `pnpm deploy:indexer:verify <TARGET_COMMIT>` after sync and before promote.
- **Always wait the full 5 min** for static-endpoint propagation before verifying — bypassing produces flaky verify results.
- **Pass the full target SHA explicitly** to status and verification steps — don't rely on "latest", since a concurrent deploy by someone else could shift it.
- **Don't open a PR** as part of deployment verification. This skill is a
  plumbing chain; pre-merge code review remains a separate workflow.
- **Default to `--no-promote` when deploying from a non-`main` branch** unless the user explicitly asked to promote. Additive feature-branch schema changes should be promoted after merge, ideally before the matching dashboard deployment serves traffic. Removals/renames need a backward-compatible/two-phase rollout or an explicit coordinated cutover/rollback plan. Promoting from the feature branch also creates an ambiguous rollback target.
