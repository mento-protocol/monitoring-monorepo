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
  platform stack must be applied before this PR's workflow change reaches
  `main`. The platform stack is a manual human apply.
- **The rename is a destroy-and-create, and this PR carries both phases.** The
  environment name is the resource's identity on GitHub, so no `moved` block
  applies, and `platform-settings-drift.yml` already names the new environment
  in the same change. ADR 0050's two-phase shape normally splits that across
  two PRs; here the operator closes the window by hand instead, because the
  platform stack is a manual apply and a split would leave a Sentry-named
  environment live behind a Sentry-removal PR. The order, also recorded at
  `terraform/github-environment.tf` "ROLLOUT ORDER": (0) before applying,
  confirm `terraform.tfvars` still sets `platform_settings_audit_token` and read
  a `terraform plan` for
  `github_actions_environment_secret.platform_settings_audit_token` as
  **replaced** — 1 to destroy and 1 to create, not destroy only; (1) apply the
  platform stack from this branch; (2) merge immediately, keeping the window
  under one 05:41 UTC cron tick; (3) verify the next scheduled
  `platform-settings-drift` run reports `state=ok`, not `state=inert`. Step 0
  exists because destroying the environment destroys its secrets server-side,
  GitHub cannot read a secret value back, and the audit-token resource is
  `count`-gated on its tfvar — so an empty value plans as destroy-with-no-create
  rather than as an error, and the PAT would have to be minted again. The same
  rollout edits the gitignored `terraform.tfvars` to strip its Sentry lines,
  which is the edit that can drop the audit-token line by accident. The other
  four environment secrets are destroyed deliberately; revoke them out of band
  (next bullet). Getting the order wrong is silent by default — the workflow
  no-ops on an unprovisioned secret and exits green — so its inert branch now
  emits a `::warning::` annotation naming the invariant it did not check.
- **Deleting resources does not revoke credentials.** The Sentry triage,
  archive and projection tokens and the `sentry-autofix` GitHub App private key
  must be revoked out of band after merge. The bridge's `sentry_auth_token`
  stays: [ADR 0004](0004-two-alert-planes.md)'s Sentry-to-Slack bridge is
  untouched by this decision.
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

- Issue #2464, PR branch `chore/remove-sentry-pipeline`.
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
  in `scripts/production-infra-identity-contract/` pins the new shape.
