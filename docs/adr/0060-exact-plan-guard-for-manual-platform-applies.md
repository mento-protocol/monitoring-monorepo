---
title: Manual platform applies use an exact private plan guard
status: active
owner: eng
canonical: true
last_verified: 2026-08-10
scope: terraform/infra
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0060 — Manual platform applies use an exact private plan guard

**Status:** Accepted (Aug 2026), in force.
**Scope:** terraform/infra

## Context

Metrics Bridge image deploys use `gcloud`, while Terraform owns the Cloud Run
service template. Google provider 6.50 can retain the generated live revision
name while planning a Terraform-owned template change. Cloud Run rejects that
old name with HTTP 409 instead of creating a new revision.

The source contract therefore has two phases. Stable mode ignores the generated
revision name. Rollout mode removes that ignore while applying one reviewed
template change, then a source-only stabilization change restores the ignore.
A static check can prove that the source marker and lifecycle block agree, but
it cannot see a template change caused by a tfvar or provider expansion. The
guard must inspect the actual Terraform plan.

Terraform saved plans can contain sensitive data. The platform also uses a
required ephemeral Alloy input that Terraform deliberately omits from plan
files, so exact-plan apply must receive the same private variable inputs again.

## Decision

`pnpm tf plan platform` and `pnpm tf apply platform` own one private saved plan
per command:

- The wrapper accepts a small Terraform argument allowlist and rejects caller
  plan paths, destroy/replace/invoke modes, `-lock=false`, injected
  `TF_CLI_ARGS*`, and non-default `TF_WORKSPACE` values.
- Every Terraform phase runs non-interactively in the default workspace with a
  private `TF_DATA_DIR` under the committed-source snapshot. An inherited data
  directory or workspace-selection file cannot redirect the checked plan.
- It plans from the verified clean current-`main` snapshot into a mode-`0700`
  temporary directory, copies each variable file there once at mode `0600`, and
  changes the binary plan to mode `0600`. Plan and apply use the same copies.
- It captures `terraform show -json` in memory with a bounded buffer. It never
  writes the JSON or prints plan values.
- It reads the literal rollout marker from the verified source and checks it
  against the saved plan. Stable mode permits only a no-op or service-level
  update whose complete known template and revision are unchanged. Rollout mode
  requires one in-place service update, a known non-revision template change,
  a named revision before apply, and that old name becoming known null or
  absent without appearing elsewhere in the new template.
- Full stable and rollout plans must have `complete: true` and contain exactly
  one canonical Metrics Bridge service entry. Aliases, module/index/deposed
  forms, previous addresses, deferred changes, action invocations, incomplete
  plans, errored plans, and unknown template changes fail closed.
- ADR 0055's exact `-refresh=false` controller-role target is the only target
  exception. Terraform marks that target plan `complete: false`; only this
  recovery may use that incomplete envelope, and its entire managed non-no-op
  diff may only create `google_project_iam_custom_role.peg_policy_bucket_controller`.
  Rollout mode forbids the recovery.
- Apply requires exactly one `-auto-approve` argument as an acknowledgement
  that explicit human approval already exists. The wrapper removes that flag,
  forces `-input=false`, re-supplies variable inputs for ephemeral values, and
  applies the checked saved plan. It skips apply when the plan has no changes.
- The wrapper removes the plan and its directory after success or failure.
  Plans and plan JSON are never committed, uploaded, cached, or handed between
  operators.

The checker approves only the Metrics Bridge template phase and the narrow ADR
0055 recovery shape. It does not approve unrelated platform changes. Operators
must still review a separate preflight plan and obtain explicit human approval
before apply. The apply creates a fresh plan, so only the machine policy reviews
the exact plan applied. Issue #1576 still owns broad policy coverage for every
retained protected-stack mutation.

## Alternatives considered

- **Keep only the static source contract** — rejected because tfvars and
  provider expansion can change the effective template without changing the
  marker file.
- **Always ignore the generated revision name** — rejected because a reviewed
  Terraform-owned template rollout must let Cloud Run mint a new revision.
- **Always manage the generated revision name** — rejected because routine
  image deploys stamp that provider bookkeeping out of band and would create
  persistent drift or redundant revisions.
- **Let apply create a second plan** — rejected because the checked plan and
  applied actions could differ.
- **Retain or upload the saved plan for human handoff** — rejected because plan
  files can contain sensitive configuration and values.
- **Wait for the broad issue #1576 policy** — rejected because the known Cloud
  Run revision failure needs a small, testable guard now. This decision remains
  a narrow first slice of that wider contract.

## Consequences

- Platform apply executes the same bytes that the Metrics Bridge checker saw.
- Human approval covers the commit and earlier preflight, not the exact apply
  plan. The narrow machine guard is the final check before mutation.
- Stable mode blocks hidden template drift; rollout mode blocks stale generated
  revision names and ambiguous template changes.
- The apply repeats the private copied variable-file arguments because
  ephemeral values are absent from the saved plan. A source variable file
  change between phases cannot alter the apply input.
- Non-interactive execution prevents an operator from entering a different
  ephemeral value when the saved plan is applied.
- The operator must pass `-auto-approve` to the wrapper after approval. That
  flag records acknowledgement; it does not authorize the change or reach
  Terraform's saved-plan apply.
- Adding another platform exception requires a reviewed policy rule, focused
  tests, and an ADR amendment. Arbitrary target and refresh exceptions remain
  closed.

## Evidence

- Plan policy:
  [`scripts/check-metrics-bridge-template-plan.mjs`](../../scripts/check-metrics-bridge-template-plan.mjs)
- Wrapper and private-plan lifecycle:
  [`scripts/tf-platform-plan-guard.mjs`](../../scripts/tf-platform-plan-guard.mjs)
  and [`scripts/tf-stacks.mjs`](../../scripts/tf-stacks.mjs)
- Regression tests:
  [`scripts/check-metrics-bridge-template-plan.test.mjs`](../../scripts/check-metrics-bridge-template-plan.test.mjs)
  and [`scripts/tf-stacks.test.mjs`](../../scripts/tf-stacks.test.mjs)
- Cloud Run phase contract:
  [`terraform/metrics-bridge.tf`](../../terraform/metrics-bridge.tf)
- Related decisions: [ADR 0047](0047-separated-terraform-ci-identities.md),
  [ADR 0054](0054-same-project-peg-policy-artifact.md), and
  [ADR 0055](0055-peg-policy-bucket-controller-recovery.md)
- Terraform saved-plan and ephemeral-value behavior:
  [plan command](https://developer.hashicorp.com/terraform/cli/commands/plan),
  [apply command](https://developer.hashicorp.com/terraform/cli/commands/apply),
  and
  [ephemeral values](https://developer.hashicorp.com/terraform/language/manage-sensitive-data/ephemeral)
- [Issue #1778](https://github.com/mento-protocol/monitoring-monorepo/issues/1778)
- [Issue #1576](https://github.com/mento-protocol/monitoring-monorepo/issues/1576)
