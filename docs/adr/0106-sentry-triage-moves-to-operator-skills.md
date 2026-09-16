---
title: Sentry triage and autofix move from a CI pipeline to operator-run skills
status: active
owner: eng
canonical: true
last_verified: 2026-09-16
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0106 — Sentry triage and autofix move from a CI pipeline to operator-run skills

**Status:** Accepted (Sep 2026), in force. Supersedes
[ADR 0036](0036-sentry-triage-pipeline.md),
[ADR 0038](0038-sentry-central-plane-verdict-projection.md),
[ADR 0056](0056-agent-mcp-credential-broker.md),
[ADR 0062](0062-sentry-suites-self-run-gate.md) and
[ADR 0070](0070-sentry-requeue-settlement-sentinel.md).
**Scope:** ci/process

## Context

[ADR 0036](0036-sentry-triage-pipeline.md) built Sentry triage and autofix as a
staged GitHub Actions pipeline with a GitHub-Issue queue.
[ADR 0038](0038-sentry-central-plane-verdict-projection.md) added verdict
projection into owning repositories,
[ADR 0056](0056-agent-mcp-credential-broker.md) put the agent's Sentry
credentials behind a loopback broker,
[ADR 0062](0062-sentry-suites-self-run-gate.md) added an unconditional gate job
that ran the suites and proved from their output that they asserted, and
[ADR 0070](0070-sentry-requeue-settlement-sentinel.md) serialized the archive
settlement against the triage re-queue with a withheld terminal label.

Three facts decide this:

- **The autofix leg merged two PRs in its lifetime.** That is the whole output
  of the leg the pipeline's most expensive machinery exists to serve.
- **Sentry already holds per-issue state.** Issue status, activity notes,
  assignment and the regressed/escalating signals are all first-class Sentry
  data. The GitHub-Issue queue re-implemented that state in a second system so
  that a stateless CI runner could read it back.
- **About 55,000 of the pipeline's ~61,000 lines exist for two properties CI
  forces and an interactive session does not:** durable state across
  independent runner invocations, and a hardened boundary around untrusted
  Sentry text reaching a credentialed, unattended agent. The broker, the queue
  contract, the re-queue sentinel, the suite gate and its wiring checker are all
  answers to "the runner is unattended and forgets everything".

An operator session has neither problem. It reads Sentry directly through the
Sentry MCP server, it holds the operator's own credentials rather than a
server-side secret an exfiltrated workflow could reach, and a human is present
for every verdict.

## Decision

Delete the CI pipeline. Replace it with two portable skills in
`~/.agents/skills`, specified for ordinary Claude, Codex and OpenClaw sessions:

- **`sentry-triage`** reads new, regressed and escalating issues in the
  `mento-labs` org, writes one machine-readable verdict note per issue back into
  Sentry, ignores upstream-transient noise `untilEscalating`, assigns
  needs-human issues to the operator, and files one GitHub issue per actionable
  verdict in the owning repository. The projected-issue format is ported byte
  for byte, so nothing downstream changes shape.
- **`sentry-fix N [in <repo>]`** sweeps those GitHub issues and drives N of them
  to ready-for-review PRs, in the shape `backlog-sweep` already uses for ranked
  backlog issues.

Sentry becomes the queue. The neutralization contract for untrusted Sentry text
(`neutralizeUntrusted`, `neutralizeBlock`, `normalizeFixScope`, the list and
text caps) is ported verbatim into the skills: the input is still untrusted,
only the thing holding the credentials changed.

## Alternatives considered

- **Keep the autofix leg, delete triage.** Rejected: autofix is the leg with the
  worst return, and it is the reason the pipeline needs an App private key, a
  branch-push identity and the CI-trust boundary around machine-authored PRs.
- **Freeze the pipeline in place, kill-switched off.** Rejected: an inert
  pipeline still costs a required check on every PR, an unconditional gate job
  per run, five provisioned secrets, a GitHub Environment, a Cloud Function
  dead-man switch, and a review surface that every unrelated CI change has to
  reason about. Frozen code is not free code.

## Consequences

- **The `sentry-suites` required check is gone.** The branch ruleset on `main`
  still requires the `Sentry suites` status check. That is live GitHub state,
  not IaC: remove it from the ruleset before or atomically with merging this
  change, or every later PR blocks on a context that will never report.
- **PLATFORM_SETTINGS_AUDIT_TOKEN gets its own environment.** The
  platform-settings drift check borrowed the `sentry-pipeline` GitHub
  Environment purely for its main-only deployment-branch policy. That token has
  nothing to do with Sentry, so it moves to a new Terraform-managed
  `platform-settings-drift` environment with the same policy. The rollout order
  from ADR 0050 still applies: a workflow `environment:` reference auto-creates
  an _unprotected_ environment if the protected one does not exist yet, so the
  protected environment must be applied before this PR's workflow change reaches
  `main`.
- **The rename is a destroy-and-create, so it takes two PRs.** The environment
  name is the resource's identity on GitHub, so no `moved` block applies. The
  platform stack can only be planned or applied by `pnpm tf plan platform` /
  `pnpm tf apply platform` from a clean `main` checkout at freshly fetched
  `origin/main` (terraform/AGENTS.md, ADR 0061), so nothing can be applied from
  this branch and ADR 0050's two-PR shape governs. The order, also recorded at
  `terraform/github-environment.tf` "ROLLOUT ORDER": (1) merge the purely
  additive phase-1 PR `chore/platform-settings-drift-environment`, which creates
  `platform-settings-drift`, its main-only deployment policy and
  `github_actions_environment_secret.platform_settings_drift_audit_token`,
  leaving `sentry-pipeline` and its five secrets live; before that apply,
  confirm `terraform.tfvars` still sets `platform_settings_audit_token` and read
  the plan for the new secret as **1 to create**, because it is `count`-gated on
  that tfvar and an empty value plans as a no-op rather than as an error; (2)
  apply the platform stack from `main`; (3) verify the scheduled
  `platform-settings-drift` run still reports `state=ok`; (4) drain the four
  retired workflows as the credentials bullet below requires, then merge this
  PR, which repoints `platform-settings-drift.yml` at the new environment and
  deletes `sentry-pipeline` — updating this branch with `main` first duplicates
  phase 1's three added blocks outside the conflict markers, so read the
  resolution note at step 4 of the rollout order before merging; (5) apply the
  platform stack from `main` again to
  destroy `sentry-pipeline`, after confirming the plan leaves
  `platform_settings_drift_audit_token` **unchanged**; (6) verify the next
  scheduled run reports `state=ok`. Between (4) and (5) the retired environment
  still exists on GitHub with nothing pointing at it: every workflow that
  declared `environment: sentry-pipeline` is deleted in this merge, so no run
  can auto-recreate it. The audit token is never at risk in this order, because
  phase 1 creates its replacement before anything is destroyed. The other four
  environment secrets are destroyed deliberately; revoke them out of band (next
  bullet). Getting the order wrong is silent by default — the workflow no-ops on
  an unprovisioned secret and exits green — so its inert branch now emits a
  `::warning::` annotation naming the invariant it did not check.
- **Deleting resources does not revoke credentials, and a running job keeps
  them.** Drain the pipeline before this PR merges. Disable
  `Sentry Triage Ingest`, `Sentry Triage Agent`, `Sentry Triage Archive` and
  `Sentry Autofix` through the Actions UI or `gh workflow disable`, then confirm
  none of the four is still executing:
  `gh run list --workflow <name> --status in_progress` and the same command with
  `--status queued` must both come back empty. Cancel what remains or let it
  finish. Each retired workflow set `cancel-in-progress: false`, so a job
  already running holds its `sentry-pipeline` secrets until it ends, and
  deleting the workflow file does not stop it. Merge only after the
  last run has stopped. The Sentry triage, archive and projection tokens and the
  `sentry-autofix` GitHub App private key are then revoked out of band. The
  bridge's `sentry_auth_token` stays: [ADR 0004](0004-two-alert-planes.md)'s
  Sentry-to-Slack bridge is untouched by this decision.
- **Issue #1282 goes quiet.** The run-record writers that appended
  `run-record:v1` comments to the public tracker issue are deleted with the
  ingest leg, and the Cloud Function dead-man switch that read those comments is
  deleted with them. Nothing writes to #1282 any more; close or repurpose it.
  Issue #1279 closes with it.
- **The 125 stub issues stay as history.** They are the queue's record of what
  was triaged; deleting them would erase the only durable account of the
  pipeline's output.
- **The `sentry:*` labels stay defined but unused.** They are attached to
  historical issues and a bulk delete would rewrite that history. The new
  `sentry-triage` skill uses a single `sentry` label instead.
- **[ADR 0036](0036-sentry-triage-pipeline.md)'s stance against an OpenClaw cron
  host is revisited only when a cron host is actually adopted.** The skills are
  interactive-first by design; scheduling them is a separate decision with a
  separate threat model, and nothing here pre-commits to one.
- **The `sentry-autofix/*` CI-trust guards are retained, not stripped.** Nothing
  can create that branch any more, so the guards are inert. They are still what
  `check-autofix-ci-trust.mjs`, `check-no-skip-audit.mjs` and
  `check-pr-validation-boundary.mjs` assert, and the first of those also carries
  the repo-wide `pull_request_target` refusal that has nothing to do with
  Sentry. Removing the guards to land this change would mean weakening the
  control that refuses it. Retiring the namespace is its own claimed task.

## Evidence

- Issue #2464, PR branch `chore/remove-sentry-pipeline`, preceded by the
  phase-1 PR branch `chore/platform-settings-drift-environment`.
- Deleted: `.github/workflows/sentry-*.yml`, `.github/prompts/sentry-*.md`,
  `scripts/sentry/**`, `alerts/infra/sentry-ingest-watcher/**`,
  `alerts/infra/sentry-triage-channel.tf`,
  `docs/notes/sentry-triage-pipeline.md`.
- Relocated rather than deleted: eight of the twelve `ci` sentinel predicates
  to `scripts/workflows/ci-sentinel-core.mjs`, and the bridge's provider
  contract to `scripts/alerts/sentry-bridge-contract.test.mjs`. The eight are
  `isPlainObject`, `envMutationBlockers`, `withInput`, `parseActionList`,
  `sentinelBlockers`, `contextOwnershipBlockers`, `triggerBlockers` and
  `pinValidationOrderBlockers`; `check-ci-contract.mjs` calls the last three,
  over every workflow file, over ci.yml's `on:` triggers, and over
  `["scripts", "docs-checks", "production-infra-contract"]` respectively, with
  mutation probes in `check-ci-contract.test.mjs`. The four not carried —
  `workflowBlockers`, `jobBlockers`, `provenCommands`, `nearMisses` — are named
  in that module's header beside the `check-ci-contract.mjs` assertion that
  already proves each one's property over a closed job set.
- Terraform: `terraform/github-environment.tf` now declares
  `platform-settings-drift` in place of `sentry-pipeline`; the identity contract
  in `scripts/production-infra-identity-contract/` pins the new shape. The
  phase-1 PR adds the same environment, deployment policy and
  `platform_settings_drift_audit_token` block byte for byte alongside the
  `sentry-pipeline` resources it leaves in place, so the two end states agree
  and the only intended Terraform effect of this branch after phase 1 lands is
  the deletion. The merge that produces that end state does not reach it on its
  own. Phase 1 appends its blocks after the `sentry-pipeline` resources this
  branch deletes, so Git marks a conflict only on the file's header comment and
  auto-merges a second copy of all three added blocks below it. Step 4 of the
  rollout order in `terraform/github-environment.tf` states the resolution:
  keep exactly one copy of each block, then re-run `terraform fmt -check`,
  `terraform validate` and `pnpm tf:test`.
