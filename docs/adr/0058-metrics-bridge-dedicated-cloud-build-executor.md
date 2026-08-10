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

**Status:** Accepted (Aug 2026). Phase 1 infrastructure is applied and
effective IAM is verified. Phase 2 routing is configured; its two canaries and
later cleanup remain in the order below. **Scope:** terraform/infra /
metrics-bridge.

## Context

Before the phase-two routing change, Metrics Bridge submits builds without a
user-specified executor. Cloud Build selects the project's default Compute
service account, which retains project Editor. The routine deployer intentionally
has no Service Account User grant on that broad identity, so submissions fail
before the build begins with a missing `iam.serviceAccounts.actAs` permission.

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

The migration is two phases. Phase 1 created the builder, its exact IAM, and
the submitter act-as grants. Its clean-current-main plan, approved apply, and
effective-IAM verification are complete. It deliberately retained default
Compute's existing source-bucket Object Viewer grant.

Phase 2 has a strict order:

1. Pin `cloudbuild.yaml` to the dedicated builder without removing default
   Compute's source reader. This repository now has that configuration.
2. Canary the GitHub `main` deploy while default Compute still has its
   temporary source-bucket reader.
3. Canary the direct `main` deploy while that reader still exists.
4. In a separate cleanup PR, remove the reader, then run a clean current-main
   platform plan and obtain explicit approval before apply.
5. Verify effective IAM and the live Metrics Bridge revision after the cleanup.

## Alternatives considered

- **Grant the deployer Service Account User on default Compute** — rejected:
  it lets a routine deploy path act as an Editor-bearing identity.
- **Use project-wide Artifact Registry or Storage roles for the builder** —
  rejected: image writes and submitted-source reads each have a single known
  resource.
- **Remove default Compute source access in the routing PR** — rejected: the
  direct-deploy wrapper runs Terraform before it builds. Removing the reader
  there would turn the direct canary into an unapproved cleanup apply.

## Consequences

- The builder foundation is live without having changed a production build
  route.
- The routing PR may merge only after the applied foundation proves the builder
  and submitter bindings exist; that proof is complete.
- The temporary default-Compute reader survives both route canaries and is
  removed only by a separate approved cleanup apply.
- The default Compute service account's broader project role remains a
  separate audit and retirement task; this decision removes it from the Metrics
  Bridge build path without assuming no other workload uses it.

## Evidence

- [`terraform/metrics-bridge.tf`](../../terraform/metrics-bridge.tf)
- [`terraform/deploy-staging.tf`](../../terraform/deploy-staging.tf)
- [`cloudbuild.yaml`](../../cloudbuild.yaml)
- [ADR 0053](0053-explicit-deployment-source-staging.md)
- [Google Cloud: configure user-specified build service accounts](https://cloud.google.com/build/docs/securing-builds/configure-user-specified-service-accounts)
- [Google Cloud: default build service account changes](https://cloud.google.com/build/docs/cloud-build-service-account-updates)
- [Issue #1751](https://github.com/mento-protocol/monitoring-monorepo/issues/1751)
