---
title: Peg policy stays private in the monitoring project
status: active
owner: eng
canonical: true
last_verified: 2026-08-10
scope: metrics-bridge / alerts / terraform/infra
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0054 — Peg policy stays private in the monitoring project

**Status:** Accepted (Jul 2026), in force. The controller recovery in
[ADR 0055](0055-peg-policy-bucket-controller-recovery.md), first protected
publication, and generation-pinned runtime attachment are complete.
**Scope:** metrics-bridge / alerts / terraform/infra

## Context

ADR 0048 chose a private, generation-pinned GCS policy artifact. It also put
that artifact in a separate GCP project to isolate it from monitoring-project
roles. The operators and routine identities that currently hold access in
`mento-monitoring` are trusted for this policy boundary. A separate project
would add billing, API bootstrap, cross-project IAM, and another operational
surface without addressing an accepted threat.

The policy still controls paging behavior, so its direct access must remain
small and reviewable. Project-level and inherited access remain effective in
the same project. It is accepted for trusted identities and must be audited
before production use.

## Decision

- Keep the policy bucket and access-log bucket in `mento-monitoring`, named
  `${google_project.monitoring.project_id}-peg-policy` and
  `${google_project.monitoring.project_id}-peg-policy-access-logs`.
- Keep the policy private, versioned, generation-pinned, public-access
  prevented, and protected from Terraform destroy. Keep the access-log bucket
  and its 90-day live and 30-day archived retention.
- Keep the runtime and publisher in `mento-monitoring`. The runtime receives
  only bucket-scoped Object Viewer; the publisher receives only bucket-scoped
  Object Admin. Keep the workflow-only publication plan and reader identities
  in the seed project. The plan identity may impersonate only the reader, which
  can view only Terraform state and policy objects. The shared refresh identity
  cannot read policy objects. The protected production applier has the only
  direct Token Creator grant on the publisher; inherited and effective IAM
  remains audited.
- Give the routine deployer and `gcp_dev_members` Service Account User only on
  the dedicated runtime identity. Do not retain a default-Compute or
  project-wide Service Account User fallback.
- Use authoritative bucket IAM policies. This ADR originally decided that the
  protected org-Terraform project Owner made an additional controller
  unnecessary. The post-apply lockout amended that controller decision;
  [ADR 0055](0055-peg-policy-bucket-controller-recovery.md) governs the
  narrow controller and its recovery bootstrap.
- Accept and audit effective project-level and inherited access for trusted
  operators. Direct bucket grants remain least-privilege evidence; they do not
  override wider accepted project or organization grants.
- Keep the protected org-Terraform project Owner and organization IAM admins as
  audited control-plane exceptions. Publication, runtime attachment, and alert
  activation remain separate reviewed steps.

## Amendment — ADR 0055

The same-project placement, direct object grants, and source-only boundary
remain in force. After the foundation applied, Terraform could not reconcile
the two authoritative bucket IAM policies through the assumed Owner path.
[ADR 0055](0055-peg-policy-bucket-controller-recovery.md) corrects only that
controller decision: it adds the narrow normal controller, permits one
explicitly approved and time-bounded project-level bootstrap when recovery
requires it, and requires removing that bootstrap immediately after both
policies reconcile. Recovery and bootstrap removal are complete; the protected
workflow has published the policy and the runtime has its generation-pinned
attachment.

## Amendment — generated Cloud Run revision names

The runtime generation remains Terraform-owned through the paired environment.
Cloud Run's generated revision name is deploy bookkeeping and stays in
`ignore_changes` only in steady state. Any Terraform-owned template change sets
`metrics_bridge_template_rollout_active = true` and removes that ignore in the
same reviewed rollout. Google provider 6.50 otherwise sends the retained old
name with changed template content, which Cloud Run can reject with HTTP 409.
[Upstream issue #14569](https://github.com/hashicorp/terraform-provider-google/issues/14569)
reproduces that mixed Terraform and `gcloud` sequence.
After the approved apply and runtime proof, a separate stabilization change
restores the marker to `false` and the ignore. Unrelated full platform applies
pause between those phases; a failed rollout stays in rollout mode until a
reviewed completion or rollback.
[ADR 0061](0061-exact-plan-guard-for-manual-platform-applies.md) checks the
source-selected phase against the exact platform plan. [Issue
#1778](https://github.com/mento-protocol/monitoring-monorepo/issues/1778)
records the drift and the correction.

## Alternatives considered

- **Separate GCP project** — rejected. It creates bootstrap, billing, API,
  cross-project IAM, and audit overhead beyond the accepted threat model.
- **Public GCS object** — rejected. The runtime has a workload identity and
  does not need public access.
- **Signed URL** — rejected. It creates an expiring bearer credential and a
  separate rotation and redaction lifecycle.
- **Policy in the bridge image** — rejected. A routine service deployment could
  change paging behavior outside the protected policy publication path.

## Consequences

- The policy keeps its integrity controls without a separate project.
- [ADR 0055](0055-peg-policy-bucket-controller-recovery.md) adds the narrow
  normal path to reconcile both authoritative bucket policies.
- Policy planning uses a workflow-specific read chain instead of extending the
  shared Terraform refresh identity.
- A future broad project or inherited storage grant also reaches this bucket;
  that is an accepted risk for trusted identities and a required IAM-audit
  check before activation.
- The source foundation creates no policy object. The separate
  `alerts/peg-policy-publication` root creates a policy object only through its
  manual protected workflow. The first publication created
  `mento-monitoring-peg-policy/peg-policy/current.json` generation
  `1785276001213660`; the reviewed runtime attachment pins it and mints
  `metrics-bridge-r-47264e8-30405040839`. Future rollovers replace the current
  quoted generation in a reviewed template-rollout phase with revision-name
  management enabled, then return to the steady-state ignore in a separate
  stabilization phase after apply and runtime proof. Publication and runtime
  attachment do not apply Grafana consumers.

## Evidence

- Policy foundation: [`terraform/peg-policy.tf`](../../terraform/peg-policy.tf)
- Controller recovery: [ADR 0055](0055-peg-policy-bucket-controller-recovery.md)
- Policy publication root: [`alerts/peg-policy-publication/`](../../alerts/peg-policy-publication/)
- Deployment-source rollout: [ADR 0053](0053-explicit-deployment-source-staging.md)
- Runtime validation: `metrics-bridge/src/peg/policy-client.ts`
- Issue: [#1444](https://github.com/mento-protocol/monitoring-monorepo/issues/1444)
