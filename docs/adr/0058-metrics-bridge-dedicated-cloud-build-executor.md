---
title: Metrics Bridge uses a dedicated Cloud Build executor
status: active
owner: eng
canonical: true
last_verified: 2026-08-10
scope: terraform/infra / metrics-bridge
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0058 — Metrics Bridge uses a dedicated Cloud Build executor

**Status:** Accepted (Aug 2026), phase 1 infrastructure pending approved
current-main apply. **Scope:** terraform/infra / metrics-bridge.

## Context

Metrics Bridge currently submits builds without a user-specified executor.
Cloud Build therefore selects the project's default Compute service account,
which retains project Editor. The routine deployer intentionally has no
Service Account User grant on that broad identity, so submissions fail before
the build begins with a missing `iam.serviceAccounts.actAs` permission.

Granting the deployer act-as on the default Compute identity would repair the
symptom while extending access to an Editor-bearing account. It would also
undo the scoped-identity posture established by ADR 0053.

## Decision

Terraform owns `metrics-bridge-builder`, a dedicated Cloud Build executor. It
receives only:

- `roles/cloudbuild.builds.editor` and `roles/logging.logWriter` at the
  monitoring project;
- Artifact Registry Writer on the `metrics-bridge` repository only;
- Object Viewer on the Cloud Build source-staging bucket only.

The routine deployer and `gcp_dev_members` receive Service Account User only on
that builder. The builder receives no Cloud Run role, runtime-identity act-as,
Storage write role, project Editor, or Token Creator grant.

The migration is two phases. Phase 1 creates the builder, its exact IAM, and
the submitter act-as grants. It deliberately retains the default Compute
executor's existing source-bucket Object Viewer grant and does not change
`cloudbuild.yaml` or either `gcloud builds submit` call. After a clean
current-main plan, explicit apply approval, effective-IAM verification, and
the approved apply, phase 2 pins Metrics Bridge builds to the builder, canaries
the GitHub and direct deploy paths, then removes the default Compute
source-bucket reader.

## Alternatives considered

- **Grant the deployer Service Account User on default Compute** — rejected:
  it lets a routine deploy path act as an Editor-bearing identity.
- **Use project-wide Artifact Registry or Storage roles for the builder** —
  rejected: image writes and submitted-source reads each have a single known
  resource.
- **Remove default Compute source access in phase 1** — rejected: existing
  submissions still use that executor until the later routing canaries prove
  the new path.

## Consequences

- The builder foundation may merge and apply without changing a production
  build route.
- The routing PR must not merge before the approved current-main apply proves
  the builder and submitter bindings exist.
- The default Compute service account's broader project role remains a
  separate audit and retirement task; this decision removes it from the Metrics
  Bridge build path without assuming no other workload uses it.

## Evidence

- [`terraform/metrics-bridge.tf`](../../terraform/metrics-bridge.tf)
- [`terraform/deploy-staging.tf`](../../terraform/deploy-staging.tf)
- [`cloudbuild.yaml`](../../cloudbuild.yaml) (phase-2 routing target)
- [ADR 0053](0053-explicit-deployment-source-staging.md)
- [Google Cloud: configure user-specified build service accounts](https://cloud.google.com/build/docs/securing-builds/configure-user-specified-service-accounts)
- [Google Cloud: default build service account changes](https://cloud.google.com/build/docs/cloud-build-service-account-updates)
- [Issue #1751](https://github.com/mento-protocol/monitoring-monorepo/issues/1751)
