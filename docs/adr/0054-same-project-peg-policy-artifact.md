---
title: Peg policy stays private in the monitoring project
status: active
owner: eng
canonical: true
last_verified: 2026-07-28
scope: metrics-bridge / alerts / terraform/infra
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0054 — Peg policy stays private in the monitoring project

**Status:** Accepted (Jul 2026), dormant and unapplied.
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
- Keep both policy identities in `mento-monitoring`. The runtime receives only
  bucket-scoped Object Viewer. The publisher receives only bucket-scoped Object
  Admin. Only the protected production applier can impersonate the publisher.
- Give the routine deployer and `gcp_dev_members` Service Account User only on
  the dedicated runtime identity. Do not retain a default-Compute or
  project-wide Service Account User fallback.
- Use authoritative bucket IAM policies. The existing protected org-Terraform
  project Owner manages bucket metadata and IAM, so no extra custom controller
  role is needed.
- Accept and audit effective project-level and inherited access for trusted
  operators. Direct bucket grants remain least-privilege evidence; they do not
  override wider accepted project or organization grants.
- Do not apply this branch until #1659's additive deployment-source staging
  foundation has merged and all five deploy paths have passed their canaries.
  This branch then removes the broad project-wide Storage Admin, Storage Object
  Admin, and Service Account User fallback grants while creating the dormant
  policy foundation. Run the effective-IAM audit after that apply. Publication,
  runtime attachment, and alert activation remain separate reviewed steps.

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
- A future broad project or inherited storage grant also reaches this bucket;
  that is an accepted risk for trusted identities and a required IAM-audit
  check before activation.
- The source foundation creates no policy object. The later runtime attachment
  assigns the dedicated reader identity to Metrics Bridge, but its paired
  policy values remain absent while the reviewed
  `local.peg_policy_runtime_generation` literal is `null`. A merge alone does
  not start Peg polling or activate alerts. That null state retains the Cloud
  Run template-revision drift ignore; a concrete generation removes it in the
  same reviewed change to mint the attachment revision.

## Evidence

- Policy foundation: [`terraform/peg-policy.tf`](../../terraform/peg-policy.tf)
- Deployment-source rollout: [ADR 0053](0053-explicit-deployment-source-staging.md)
- Runtime validation: `metrics-bridge/src/peg/policy-client.ts`
- Issue: [#1444](https://github.com/mento-protocol/monitoring-monorepo/issues/1444)
