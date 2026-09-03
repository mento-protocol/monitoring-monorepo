---
title: PR Operating Card
status: active
owner: eng
canonical: true
last_verified: 2026-09-03
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# PR Operating Card

The one-card loop for taking an agent task from claim through any required
production closeout. It replaces the old habit of reading the full stack of
operating runbooks up front: work the steps here, and open an authority doc only
when a specific step's decision needs its depth. Each step is terse on purpose
and names its owning authority. Root [`AGENTS.md`](../../AGENTS.md) routes here
first; the hard invariants below and in the Non-negotiables section are binding
even when you never open an authority.

## The loop

**Run the repository preflight first.** Automatic setup can finish before agent
control under a [separate trust boundary](worktree-and-web-setup.md); this
preflight does not attest it. Before step 1 or any repository command, resolve
`CURRENT_REPO`, `BASE_REPO`, the target PR when one exists, `BASE_REMOTE`,
`HEAD_REMOTE`, and the PR base with the exact step 5 rules. Read
`headRepository`, `headRepositoryOwner`, and `isCrossRepository` for an
existing PR. With no PR, require a non-fork checkout whose `origin` serves
`CURRENT_REPO`. Stop on a fork checkout, a cross-repository head, an ambiguous
target, or a failed identity lookup before the agent executes repository code.
Fetch the base only after its repository and remote are bound. Keep these
values as the authority for author checks and publication, and re-read them
before each publication mutation in step 5. Before step 1, inspect resolved-base
and working-tree changes, including untracked files, for package manifests,
package-manager configuration, lockfiles, and patches. Review lifecycle and
install effects before any package-manager command, including the claim command.

1. **Claim.** Before substantive edits, claim from the ready queue:

   ```bash
   pnpm issue:claim --count 3 --agent codex
   ```

   Claiming moves the issue out of the ready queue. Keep each printed Claim ID.
   If you cannot continue, release it with
   `pnpm issue:release --issue <n> --claim-id <claim-id>` (add
   `--needs-grooming` when clarity is missing; default restores
   `agent-ready`). Authority:
   [`agent-issue-workflow.md`](agent-issue-workflow.md).
   After a PR closes unmerged, add `--closed-unmerged-pr`. The helper then
   proves the stored PR and branch binding before release.
   A manual `--count` claim records the current checked-out branch. If step 2
   creates the final PR branch afterward, keep the Claim ID for the explicit
   owner-checked branch rebind in step 6.

2. **Implement.** Work in a dedicated per-PR worktree and unique branch, never
   directly on `main`. Keep the diff surgical: touch only what the task needs,
   match existing style, do not smuggle in adjacent cleanup. Read the scoped
   `AGENTS.md` for the package you are editing (see the root Package Routing
   Index) before touching it. A change to stateful data flow across indexer,
   GraphQL, or UI first applies
   [`../pr-checklists/stateful-data-ui.md`](../pr-checklists/stateful-data-ui.md);
   an architecture change that constrains future work records an ADR in the
   same PR. When a change adds or alters a command, script, env var, hook, or
   ordered runbook, audit every live entry point and runbook in the same PR.
   After adding, renaming, or removing a doc, or changing its catalog metadata,
   run `pnpm docs:index --write` in the same PR or `docs:index --check` fails.
   Before touching or moving docs, read
   [`../context-standards.md`](../context-standards.md).

3. **Author checks.** Apply every matching row below after the change is
   coherent and before the first ready-for-review publication. Invoke the
   existing commands directly. Do not add a selector or wrapper. First run
   `./tools/trunk fmt <surviving-changed-files>` on each intended changed file
   that exists in the final tree. Use deleted paths and both sides of a rename
   to select matching rows, but never pass a missing path to Trunk. Start the
   checks only after formatting is complete.

   | Change trigger                                                                                                                                                                                                                                                                                           | Required direct author checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
   | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Source in a workspace package                                                                                                                                                                                                                                                                            | Run each script that exists for that package: `pnpm --filter <package-name> lint`, `pnpm --filter <package-name> typecheck`, and its normal unit-test command. Governance Watchdog uses `pnpm --filter @mento-protocol/governance-watchdog test:unit`; its generic `test` needs a local service. For `metrics-bridge/src/metrics.ts`, `metrics-bridge/src/cdp-metrics.ts`, `metrics-bridge/src/peg/metrics.ts`, or `metrics-bridge/src/peg/listing-metrics.ts`, also run `pnpm alerts:rules:lint`.                                                                     |
   | Dashboard React or client source                                                                                                                                                                                                                                                                         | Also run `REACT_DOCTOR_BASE_REF=<resolved-pr-base> pnpm --filter @mento-protocol/ui-dashboard react-doctor:diff`.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
   | Dashboard UI or visual output, route or interaction, browser test, or frontend build/runtime path                                                                                                                                                                                                        | Also run `pnpm dashboard:build`, then follow [`dashboard-verification.md`](dashboard-verification.md) for the changed UI or runtime path, console, interaction, breakpoints, and applicable auth states.                                                                                                                                                                                                                                                                                                                                                               |
   | Dashboard bundle input listed in the `dashboard` path filter in `.github/workflows/size-limit.yml`                                                                                                                                                                                                       | When `shared-config/**` changes, first run `pnpm --filter @mento-protocol/config build`. After any required install and shared-config build, run `pnpm dashboard:build`, then `pnpm dashboard:size-limit`. Run a command once if another row also selects it.                                                                                                                                                                                                                                                                                                          |
   | `alerts/rules/peg-thresholds.json`, `metrics-bridge/peg-registry.json`, `shared-config/chain-metadata.json`, `shared-config/deployment-namespaces.json`, `shared-config/oracle-reporters.json`, `shared-config/src/chains.ts`, `shared-config/src/oracle-reporters.ts`, or `shared-config/src/tokens.ts` | Run `node scripts/alerts/check-peg-registry-integrity.mjs --base-ref <resolved-pr-base-oid>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
   | `shared-config/src/thresholds.ts`, `alerts/rules/main.tf`, or `alerts/rules/rules-fpmms.tf`                                                                                                                                                                                                              | Run `node scripts/alerts/check-deviation-threshold-drift.mjs`. For `shared-config/src/thresholds.ts`, also run `pnpm --filter @mento-protocol/indexer-envio exec vitest run deviationThresholdSharedConfigSync`.                                                                                                                                                                                                                                                                                                                                                       |
   | Indexer schema, configuration, ABI, entry point, handler reachability, or reserve-yield handler/RPC source                                                                                                                                                                                               | Run each affected code-generation variant from [`../../indexer-envio/AGENTS.md`](../../indexer-envio/AGENTS.md). For reserve-yield handler/RPC source, `indexer-envio/src/EventHandlers.ts`, or `indexer-envio/config.multichain.mainnet.yaml`, run `pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test`. Run affected non-mainnet variants first and `pnpm indexer:codegen` last. Inspect the generated diff before indexer package checks.                                                                                                       |
   | Dashboard GraphQL query or schema consumer, `indexer-envio/schema.graphql`, or `scripts/envio-schema-stubs.graphql`                                                                                                                                                                                      | Run `pnpm dashboard:codegen` and inspect the generated diff. For `indexer-envio/schema.graphql` or `scripts/envio-schema-stubs.graphql`, also run `pnpm --filter @mento-protocol/ui-dashboard test` and `pnpm --filter @mento-protocol/metrics-bridge test`.                                                                                                                                                                                                                                                                                                           |
   | Manifest, lockfile, pnpm configuration, or patch                                                                                                                                                                                                                                                         | Inspect lifecycle and install effects. Run `CI=true pnpm install --frozen-lockfile` from the repository root. When one of these inputs changes under `alerts/infra/onchain-event-handler`, `alerts/infra/oncall-announcer`, or `governance-watchdog`, also run `CI=true pnpm install --frozen-lockfile --ignore-scripts --lockfile-dir .` from that root. For either alert function's `pnpm-workspace.yaml`, also run `node --test scripts/supply-chain/alerts-uuid-overrides.test.mjs`. Complete the installs before code generation or the applicable package rows.  |
   | Package Vitest configuration or hermetic setup                                                                                                                                                                                                                                                           | Run `node scripts/repo-health/check-hermetic-vitest-setup.mjs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
   | Trunk configuration or local Git hook                                                                                                                                                                                                                                                                    | Run `./tools/trunk check --ci --all` and `node scripts/workflows/check-github-action-pins.mjs`. Also run `bash scripts/bootstrap/agent-setup-contract.test.sh` when hook or Trunk action behavior changes.                                                                                                                                                                                                                                                                                                                                                             |
   | Shell file, hosted agent setup, or hook                                                                                                                                                                                                                                                                  | Run `bash -n` on each surviving changed shell file. Run `bash scripts/bootstrap/agent-setup-contract.test.sh` when hosted setup or hook behavior changes.                                                                                                                                                                                                                                                                                                                                                                                                              |
   | Agent instruction, role, command, skill, runtime configuration, or catalog-visible document metadata                                                                                                                                                                                                     | Run `pnpm agent:context-check`, `pnpm agent:context-budget:test`, and `pnpm agent:context-budget --strict`. Also run `pnpm docs:index --check` after adding, moving, or removing managed context, or changing catalog-visible metadata.                                                                                                                                                                                                                                                                                                                                |
   | Mirrored agent skill content or mirror checker                                                                                                                                                                                                                                                           | Run `node scripts/repo-health/check-skills-mirror.mjs` and `node scripts/repo-health/check-skills-mirror.test.mjs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
   | Guardrail prose pin list or pinned normative text                                                                                                                                                                                                                                                        | Run `node scripts/repo-health/check-guardrail-prose.mjs` and `node scripts/repo-health/check-guardrail-prose.test.mjs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
   | GitHub Actions workflow or action, or protected PR admission boundary                                                                                                                                                                                                                                    | Run `pnpm ci:contract:test`, `node scripts/workflows/check-github-action-pins.mjs`, and `node scripts/workflows/check-autofix-ci-trust.mjs`.                                                                                                                                                                                                                                                                                                                                                                                                                           |
   | `.coderabbit.yaml`                                                                                                                                                                                                                                                                                       | Run `pnpm coderabbit:config:test`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
   | `.lighthouserc.cjs`                                                                                                                                                                                                                                                                                      | Run `node scripts/lighthouse-config.test.mjs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
   | `.gitignore`                                                                                                                                                                                                                                                                                             | Run `pnpm review:eval:test`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
   | Upstash MCP configuration, runtime, pin, operator contract, or forensic-report skill mirror, including its package, lockfile, and Terraform inputs                                                                                                                                                       | Run `node --test scripts/mcp/upstash-mcp-config.test.mjs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
   | `terraform.stacks.json`                                                                                                                                                                                                                                                                                  | Run `pnpm tf:test`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
   | New top-level package/service root with `AGENTS.md` or `package.json`, new workspace package registration, new Terraform stack registration, or new GitHub Actions workflow file                                                                                                                         | Run `pnpm adr:check --base <resolved-pr-base> --include-untracked`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
   | Root tooling, control plane, standalone service, or alert delivery/rule input                                                                                                                                                                                                                            | Run the focused existing contract named by the nearest scoped `AGENTS.md`. Do not add a root selector. For `alerts/rules/**`, run `pnpm alerts:rules:lint`. For `alerts/infra/onchain-event-listeners/**` or `alerts/infra/channels/**`, run the alerts-onchain-event-handler package lint, typecheck, and test. For its Safe ABI, event-hash generator, or event-hash output, run its `build:event-hashes` script and inspect the generated JSON diff. Run `node --check` on each surviving changed `governance-watchdog/infra/quicknode-filter-functions/*.js` file. |

   Use the resolved PR base, not a fixed `origin/main`, for every diff-based
   author check, including stacked PRs. Fetch it before the check. The root
   React Doctor alias uses `origin/main`. Use the explicit table command for
   any other base.

   Run mutable checks in this order: inspect package-manager changes; run the
   frozen install when its row applies; run code generation; run package lint,
   typecheck, tests, integrity, and parity checks; run React Doctor, build,
   size-limit, and browser checks; then run step 4. Record each applicable
   result in the PR's `## Validation` section as `passed`, `failed`, or
   `not run: <reason>`.
   A failed author check blocks the ready handoff and cannot be relabeled.
   Record an unavailable tool as `not run`. Required CI remains merge authority
   and owns coverage, Knip, broad dependency and supply-chain audits,
   full-browser suites, and legacy-gate self-tests.

   Apply only the rows affected by a material fix before publishing the new
   head. Apply the table again after base integration because conflict
   resolution creates a new tree. Do not run the table on every commit or
   push. Pre-commit keeps staged formatting only. Pre-push starts no repository
   check, fetch, lock, or wait. A manual push can omit author checks. It cannot
   omit required CI.

   If pre-commit changes a file, stop before push. Apply its author-check rows
   and step 4 to the committed tree. Do not publish unchecked formatter changes.

4. **Autoreview.** Freeze the scope baseline first — the initial request,
   target/owner, changed-file set, and non-test changed-line count — as the
   reference Babysit (step 6) checks new additions against. Then, for a
   non-trivial completed batch, run the closeout review.

   **Test the validation claims against what the run actually establishes.**
   On a re-run for an open PR that is its `## Validation` section; on the first
   pass there is no PR yet, so apply the same test to the claims you are about
   to write. Either way every claim names the evidence behind it and the
   nearest stronger claim that evidence does not support, and an unexplained
   strengthening of a claim is a finding. **This is the running agent's job,
   not the bundled reviewer's**: the prepared bundle carries the diff and the
   selected checklists, not the PR body or the command output behind a claim,
   so a reviewer confined to it cannot see the claims to test. Do it where the
   claims and their evidence are both in hand. Outside an active
   Codex session — the standalone helper or `--engine claude` — a bare
   `pnpm agent:autoreview` is the closeout, matching root
   [`AGENTS.md`](../../AGENTS.md). The skill routers defer to this step rather
   than defining the choice themselves, so do not read the agreement between them
   as a second source. With no codex CLI (Claude cloud) it falls back to
   `--engine claude` itself. Inside an active
   Codex session, a bare
   invocation silently selects the local deterministic engine — the `ship`
   skill's bare closeout is NOT sufficient there; use the prepared-bundle
   fresh-context flow so a separate reviewer inspects every pass:

   ```bash
   pnpm agent:autoreview --prepare-bundle-dir <dir>  # publish the review bundle
   pnpm agent:autoreview --verify-bundle-dir <dir>   # pre-review manifest check
   pnpm agent:autoreview --verify-bundle-dir <dir> \
     --expected-bundle-manifest <digest-from-pre-review-check>  # post-review check
   ```

   Prepare the bundle, run `--verify-bundle-dir` immediately before review,
   retain its printed digest outside the bundle, and pass that digest to the
   post-review check above so bundle replacement or drift during review
   cannot go undetected. Autoreview reviews the complete branch-local
   target without truncation, but it is **source review only**: it runs no
   tests and proves no behavior, so the direct author checks, browser,
   generated-artifact, and runtime checks still apply. One fresh-context
   reviewer must inspect every prepared-bundle pass, with manifest
   verification before and after review. Capture, bundle-integrity,
   sensitive-input, runtime-trust, and explicitly-selected-unavailable-engine
   failures all fail closed. For merge-review provenance, the `babysit-pr`
   skill binds `origin`, the immutable base, and protected `main` before it
   calls an absolute wrapper and helper through `/bin/bash`. If a review axis
   changes a pinned runtime, use the last independently reviewed compatible
   pre-change runtime. After semantic review and bound postverification, run
   the sequential `/bin/bash` suite as behavior evidence. Exact pins and
   authority:
   [`agent-quality-gate-mechanics.md`](agent-quality-gate-mechanics.md).

5. **Ship.** Open the PR through the `ship` skill on every surface, including
   hosted sessions — do not hand-roll PR creation. The description follows the
   repo template
   [`.github/PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md)
   in full, all four sections: `## The Problem` (maximum three bullets — old
   behavior, what failed, concrete effect), `## The Solution` (new behavior,
   why it improves the situation, material limits), then `## Details`
   (implementation specifics) and `## Validation` (commands and results).
   Write the opening for an engineer who has not read the diff.
   `scripts/pr/check-pr-description.mjs` enforces the first two sections and
   their order in CI; raw HTML other than comments and code blocks do not
   satisfy its opening-content check. PRs open **ready for
   review, never as drafts** — a draft silently disables CodeRabbit
   auto-review (`.coderabbit.yaml` keeps `reviews.auto_review.drafts` false)
   and the `pr-description.yml` CI check, which skips draft PRs; drafting is
   skipping review, not a staging step. A ship that updates an **existing draft** converts it to ready once
   the author checks and closeout review pass — `pr:ready-state` holds draft state as a required blocker,
   so an unconverted draft never reaches all-clear. Use or keep draft only
   when the user asks or required validation is intentionally pending, and
   state that reason in the body. Link
   the issue with `Closes #N` **only when the issue's Done means is fully
   satisfied**; otherwise use `Refs #N`. For issue-backed work, once the PR is
   open, run `pnpm issue:review --pr <pr> --issue <issue>` to move the issue
   out of `agent-active` and into review. If the stored claim Branch differs
   because the PR branch was created after the claim, run
   `pnpm issue:review --pr <pr> --issue <issue> --claim-id <claim-id> --rebind-branch`.
   This path proves the open same-repository PR and refuses an open PR on the
   old Branch. Do not pass `--branch` to review. Authority:
   [`agent-issue-workflow.md`](agent-issue-workflow.md).

   **Re-read the repository identities.** The preflight before step 1 resolves
   the checkout repository and its upstream base. Before any publication
   lookup or mutation, resolve them again —
   `gh repo view --json nameWithOwner,parent` locally, the session-attached
   repository metadata in a Claude cloud session. `CURRENT_REPO` is the
   checkout's own repository; a fork checkout uses its parent as `BASE_REPO`,
   a non-fork uses itself as both. Without it a fork checkout is
   indistinguishable from its parent and the lookup or creation below can bind
   to the wrong repository.

   **Then identify the target PR**, in this precedence: a
   user-supplied URL is used verbatim and its owner/repository overrides the
   inferred base; a bare number binds to `BASE_REPO`; with no explicit target,
   list open PRs on `BASE_REPO` for the current branch, filter by
   `headRepositoryOwner` so a same-named fork branch cannot match, and require
   exactly zero or one result — more than one is a stop, not a guess. A failed
   query is not evidence that no PR exists.

   **Resolve the remotes too.** `BASE_REMOTE` is the configured remote whose URL
   matches `BASE_REPO`; if none matches, add the parent as `upstream` and never
   overwrite or retarget an existing remote. `HEAD_REMOTE` is the remote serving
   the PR's head repository. A fork's `origin` is never a substitute for its
   parent.

   Only after the target and `BASE_REMOTE` are resolved, make the history
   complete before any ancestry decision: when
   `git rev-parse --is-shallow-repository` reports `true`, run
   `git fetch --unshallow "$BASE_REMOTE"` and refetch the base. A hosted depth-1
   checkout otherwise reports a false ancestry failure, which turns into an
   unnecessary base merge or a stop on an already-current branch.

   **When the deep security scan cannot run, say so.** The `claude-security`
   scan is developer-installed and Claude Code only; this repo does not declare
   it. Where the diff touches authn/authz, secrets handling, injection surfaces,
   network-facing handlers, deploy/CI paths, or onchain code and the plugin is
   unavailable, aim the direct author checks and closeout review at those
   surfaces instead,
   and record `Claude Security scan: skipped (<surface>)` in the final summary so
   the deep pass can be run later from a session that has it. Never imitate or
   install it to fill the gap.

   **Bind the checkout to the target first, then commit** — binding after
   advancing local `HEAD` would make the `HEAD == headRefOid` check
   unsatisfiable on a normal update:
   - **An existing PR** is the push target. Before creating the ship commit,
     require local `HEAD` to equal its `headRefOid`; if intended commits
     already exist locally, require that OID to be their ancestor and inspect
     the intervening range. If the branch is missing current base commits,
     merge the base in — rebase is only acceptable before first publication.
   - **No PR yet**: a fork checkout stops here rather than first-publishing —
     step 6 refuses every fork head, so pushing to the fork's `origin` and
     opening a cross-repository PR creates one this same workflow can never
     drive to ready; surface that to the user instead. Otherwise verify
     `origin` serves `CURRENT_REPO` and take the current branch as the head
     ref.

   **Then commit the validated work**: stage only the intended files and create
   the ship commit before any push, or the remote receives the old commit while
   every validated change stays local. If unrelated dirty changes are mixed
   with the intended scope, stop and ask before staging.

   **Then push**, always with an explicit refspec: an existing PR takes
   `git push <head-remote> HEAD:<headRefName>`, never an implicit target or the
   local branch name; a first publication takes
   `git push -u origin HEAD:<branch>` and the PR is created from that branch.

   **Integrating the base produces a new, unvalidated head.** Steps 3-4 ran
   against the pre-merge tree, so either integrate the base before step 3 or
   rerun the applicable author checks and the closeout review against the
   merged head before pushing. A conflict resolution is exercised, not assumed.

   Either way, re-read the PR after pushing and require its `headRefOid` to
   equal local `HEAD` before treating anything as published. A fork checkout
   uses its parent as `BASE_REPO`; never substitute a fork's `origin` for its
   parent, and stop if the head repository has no matching push remote.

6. **Babysit.** Run the `babysit-pr` skill. A babysit-only entry (any
   invocation that skipped step 5, with or without an explicit PR) first binds
   the target as step 5 defines: the target-PR precedence, `BASE_REPO`, both
   remotes, and
   `number,url,headRefName,headRefOid,baseRefName,headRepository,headRepositoryOwner,isCrossRepository`.
   **Stop a fork head at that resolution, before the first repo-local probe or
   fix** — the `.claude/babysit-pr.sh` refusal is the backstop, not the first
   line. Sweep every feedback
   surface:
   top-level comments, review bodies, inline comments and threads, annotations,
   and failing logs. **Reply before resolving**, on the correct surface, in
   these exact forms:
   - `Fixed in <commit> — <what changed>`
   - `Won't fix: <technical reason why>`

   After finding one instance of a hazard, audit its sibling surfaces — bots
   sample, they do not enumerate; review is a batch-boundary verifier, not the
   inner edit loop. Never force-push or amend while babysitting,
   and `git fetch` before every push because reviewers push mid-session. Check
   new additions against the scope baseline frozen at step 4; classify each as
   in-scope, follow-up, or stop; **file a labeled GitHub issue before deferring
   any valid follow-up** and link it from the PR's `## Deferrals` section. Warn
   as the diff approaches twice the baseline. Do not pause solely for cycle count
   before five review-triggered patch cycles are complete; pause for
   reclassification before starting a sixth. Authority:
   [`agent-issue-workflow.md`](agent-issue-workflow.md) for the deferral and
   issue-lifecycle rules.

   The same checkout binding as step 5 applies before any blocker fix mutates
   files: clean worktree, local `HEAD` equal to the resolved `headRefOid`,
   explicit push refspec, re-verified OID afterwards. If binding fails, move to a
   clean dedicated checkout rather than editing an unbound one.

   **Fix only failures this PR caused.** A required check that is red from
   infrastructure, base-branch breakage, or a transient failure is reported and
   left alone — check whether the same failure appears off this PR before
   attributing it. Chasing an unrelated failure puts unrelated changes on the
   branch.

   After a material fix, rerun the step 3 rows whose inputs or surface changed.
   Run step 4 again when its materiality rule applies. Publish the new head only
   after each applicable author check is `passed` or truthfully recorded as
   `not run: <reason>`.

   **A user correction updates the request baseline**: update the PR
   description before the next push, or current-head reviewers enforce the
   superseded criteria and re-raise findings you already resolved. This and
   recording a deferral are the only description edits the babysit step makes.

   **Low noise is for unsolicited updates only.** Report state changes that
   matter, not polls — but answer a status request immediately: PR URL or
   number, bound head SHA, latest readiness result and its observation time,
   current action and owner, any blocker, and the next action or deadline. Then
   keep watching.

   **Bound the watch**: one hour of wall clock by default unless the user set
   a different budget, and roughly three attempts at the same recurring item
   before handing it back. `pnpm pr:ready-state --watch` polls until ready,
   merged, or closed, so a permanently blocked PR otherwise consumes the
   session. At the deadline, report where the PR stands and stop or escalate.

   **Give each independent PR its own watcher and isolated worktree** — a
   shared foreground watch lets feedback and failures age on the other PRs,
   and repairs through one shared checkout can target the wrong branch. Bind
   every worker to that PR's exact repository, number, head and branch;
   serialize only overlapping or dependent fixes. The lead keeps user-facing
   status and approval boundaries.

   **Stacked PRs are the normal case here**, typically after a `/ship` batch.
   When a watched PR merges or a base moves, re-evaluate every open PR that
   depended on it — including ones the user never named — before calling a batch
   healthy. A squash merge rewrites the commits a dependent branch still carries,
   so expect conflicts there. A ready verdict on a still-open PR is revocable:
   any change to it or its base returns it to full evaluation against the new
   head.

7. **Ready-state.** Before signalling all-clear, run both projections with
   `<BASE_REPO>` resolved from the PR URL as step 5 defines it, so a fork PR or a
   switched checkout cannot bind the query to the wrong repository:

   ```bash
   pnpm --silent pr:feedback-state --pr <number> --repo <BASE_REPO> --json
   pnpm pr:ready-state --pr <number> --repo <BASE_REPO> --json
   ```

   Run them in that order and preserve the two-projection contract. The
   feedback ledger must be clean **first**. Before the final pair, apply the
   CodeRabbit exact-head closeout in
   [`pr-ready-state.md`](pr-ready-state.md). The subsequent
   current-head `pr:ready-state` must report ready, including the current-head
   `chatgpt-codex-connector[bot]` PR-description approval, unless a documented
   human break-glass comment applies:
   `/pr-ready-override gate=codex-description-approval head=<full-head-sha>
reason=<why this is safe>`. Do not block on slow optional bots that branch
   protection does not require, and do not post routine or duplicate `@codex
review` requests. **Never tag `chatgpt-codex-connector` directly** — it is
   lifecycle-triggered, and a direct tag produces a duplicate pass, not a
   faster one; treat `@codex` and `@Codex` as one trigger. Authority:
   [`pr-ready-state.md`](pr-ready-state.md).

   **Report an all-clear with its evidence, never bare.** Name the PR URL or
   number, the current head SHA the result is bound to, the required-check
   state, and the probes' blocker, thread and unreplied counts — a bare "it's
   green" hides which head the claim was established against.

8. **Merge hygiene.** **Agent sessions never merge a PR without the user's
   explicit, direct approval of that specific merge.** Green CI, bot approvals,
   a READY ready-state, and "ship it" do not authorize a merge. Drive the PR to
   ready, present the evidence and PR link, then stop at ALL_CLEAR. The
   repository's narrow Dependabot lane is the only unattended merge lane. It
   is not authority for an agent to merge or to widen that lane.

   A human operator normally opens the exact pull request in GitHub, confirms
   the current head, required checks, and feedback state, and uses GitHub's
   merge button. If the user gives explicit, direct approval for an agent to
   merge that specific PR, the agent re-runs the current-state probes and uses
   GitHub's merge API. The merge request must use
   `--squash --match-head-commit <head-sha>` or the REST fields
   `merge_method: "squash"` and `sha: "<head-sha>"`. It must abort on a head
   mismatch. GitHub's PR and merge record is the merge evidence.
   [ADR 0084](../adr/0084-github-ui-operator-merge.md) owns this merge path. [ADR
   0081](../adr/0081-narrow-dependabot-auto-merge-exception.md) owns the
   separate machine exception.
   `.github/workflows/dependabot-auto-merge.yml` is a separate,
   machine-authorized lane. It accepts only Dependabot-authored minor and patch
   updates for GitHub-owned `actions/*` packages in the `github_actions`
   `actions-minor-patch` group on `main`, after the seven-day cooldown. It
   refuses major, security, maintainer-changed, third-party publisher,
   `actions/create-github-app-token`, other-ecosystem, mixed-author, and
   non-workflow-file changes at enable time. Load-bearing gate and credential
   actions from other publishers, such as `re-actors/alls-green` and
   `google-github-actions/auth`, stay on the operator-authorized path. A read-only
   `pull_request` classifier verifies event identity and Dependabot metadata.
   A default-branch `workflow_run` writer treats that result as untrusted. It
   binds pre-job concurrency to the upstream head repository and branch, so a
   fork with the same branch name cannot cancel the trusted writer run. It
   re-reads the workflow, run, first-attempt jobs with `total_count`, current PR
   and head, the complete issue-event close history, all commits, all files,
   the current PR body's exact `Maintainer changes` marker, and the base's
   merge-queue state. It never checks out PR code or reads upstream outputs,
   artifacts, or caches. It waits for every required check and verifies a
   non-empty passing required-only projection. The wait is an untrusted delay.
   The writer repeats the complete workflow, run, job, PR, head,
   maintainer-change body, close-history, commit, file, and queue proof after
   it. It then calls the synchronous REST merge endpoint with the exact head
   SHA and squash method.
   The endpoint cannot enqueue or leave a standing auto-merge request. A later
   push cannot satisfy the exact-head write. A recorded close remains a durable
   human veto after the same PR and head are reopened. Dependabot must open a
   new PR before this lane can merge that update automatically. The writer
   makes the issue-event read its final authoritative read. The REST write
   cannot pin that history, so a close and reopen inside the remaining request
   window is a residual race.
   Merges made with this workflow's
   automatic `GITHUB_TOKEN` do not emit this repository's `push` workflows;
   required pull-request checks are the final automated evidence for this
   narrow lane. The writer refuses if `main` has a merge queue. The repository
   accepts the built-in token's residual risk for this bounded routine group.
   `GH_READ_TOKEN` and `FINAL_MERGE_TOKEN` both resolve to `github.token` by
   design. Keep them separate so tests can prove that evidence reads use the
   read seam and only the synchronous exact-head REST request uses the final
   write seam. Issue #2091 was closed as not planned. Do not add a
   `merge-operators` Team, credential broker, dedicated merge App, protected
   merge Environment, or controlled lifecycle ruleset for this lane. Agent
   sessions stop at ALL_CLEAR unless the user directly approves that specific
   merge. A human normally uses the GitHub UI for ordinary merges.
   If an operator-approved merge satisfies Done means, sync the issue state and
   workboard afterward per
   [`agent-issue-workflow.md`](agent-issue-workflow.md). If live proof remains,
   continue to production closeout first. After a partial merge, keep the issue
   open. Update the issue body to mark merged work complete, isolate the
   remaining acceptance criteria, and restate the current Done means. Then run
   `pnpm issue:release --issue <n> --claim-id <claim-id> --merged-pr --needs-grooming`.
   The helper proves the stored merged PR and Branch, clears the exact owner,
   and never restores `agent-ready`. Generated documentation-garden packets are
   the exception: do not edit their immutable issue bodies. A human can resume
   the frozen packet or create a linked ordinary follow-up before closing it.
   Record merged work in issue comments and PR links. Authority:
   [`documentation-gardening.md`](documentation-gardening.md).

9. **Production closeout when required.** When Done means includes deployed or
   live behavior, merge is an intermediate state. Monitor the owning deployment
   to a terminal result, obtain any separate apply or promotion approval, and
   run the owning package's production checks. Report merge, deployment, and
   live proof as separate facts; a successful workflow alone does not prove the
   runtime behavior. Use `Refs #N` instead of `Closes #N` when proof can happen
   only after merge. Close the issue only after the live acceptance criteria
   pass. Then use the repository-wide `pnpm issue:board sync --dry-run` preview
   and authorized apply contract in
   [`agent-issue-workflow.md`](agent-issue-workflow.md).

## Non-negotiables

These bind regardless of which step you are on:

- **Agent sessions never merge without explicit approval** for that specific
  merge. The default workflow stops at ALL_CLEAR. A human normally performs the
  merge in the GitHub UI. An explicitly approved agent uses GitHub directly as
  defined in step 8. The exact Dependabot lane is the only unattended exception.
- **Reply before resolving** every feedback item, in the two forms above; a
  clear reply stops re-raising bots from looping.
- **`Closes #N` only when Done means is fully met**, else `Refs #N`.
- **Knowingly deferred work needs a GitHub issue first**, linked from
  `## Deferrals`. Every issue an agent files carries a state label, a `kind:*`,
  at least one `pkg:*`, and exactly one `risk:*` set by the
  [Low-risk rule](agent-issue-workflow.md#low-risk-rule). An evidence-backed
  won't-fix is not a deferral.
- **Never weaken a control that is blocking your own work.** Do not widen,
  disable, or soften the author-check contract, the sandbox or permission config, branch
  protection, or a safety-boundary rule to unblock the change you are making
  now — an agent that can widen its own gate has no gate. Stop and hand the
  control change to an independent session through a brief or an agent-ready
  issue, with the operator's recorded consent. Routine control maintenance
  stays allowed when it is its own claimed task and does not unblock the same
  session's current work; reclassifying the blocking change as a separate task
  does not qualify.

  **When the control blocks its own repair** — broken branch protection
  rejecting the PR that fixes it, a gate whose own bug fails every run — the
  hand-off alone deadlocks: the receiving session is blocked by the same
  control, and its fix would unblock its own task. That case needs the
  operator's explicit consent to the specific repair, recorded on the issue or
  PR, and the repair stays narrowly scoped to restoring the control. It is
  still reviewed: use the last independently reviewed pre-change runtime for
  an executable control, or an independent reviewer for the diff. Widening the control
  beyond the repair, or using this path for anything the control was correctly
  refusing, is the thing this rule exists to prevent.

- **Inspect package-script, package-manager, lockfile, and patch changes before
  any package-manager command.** Record the applicable author-check results.
  Never treat a failed or unavailable command as a pass.
- **Secrets are IaC-owned and Terraform apply needs human approval** — plan
  first, never one-off `gh secret set` / `vercel env add` /
  `gcloud secrets versions add`.

## Authority map

| Step                     | Authority doc                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Claim, defer, merge-sync | [`agent-issue-workflow.md`](agent-issue-workflow.md)                                                           |
| Author checks            | step 3 here                                                                                                    |
| Autoreview               | step 4 here and [`agent-quality-gate-mechanics.md`](agent-quality-gate-mechanics.md)                           |
| Ready-state              | [`pr-ready-state.md`](pr-ready-state.md)                                                                       |
| Docs and drift           | [`../context-standards.md`](../context-standards.md)                                                           |
| Ship                     | steps 2-9 here; entry points in [`codex-agent-skills.md`](codex-agent-skills.md#claude-global-store-shadowing) |
| Babysit                  | steps 6-7 here; entry points in [`codex-agent-skills.md`](codex-agent-skills.md#claude-global-store-shadowing) |
| UI visual evidence       | [`dashboard-verification.md`](dashboard-verification.md)                                                       |
| Production closeout      | [`../deployment.md`](../deployment.md) and the owning package runbook                                          |
