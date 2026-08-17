---
title: Peg policy bucket controller recovers authoritative IAM reconciliation
status: active
owner: eng
canonical: true
last_verified: 2026-07-28
scope: terraform/infra
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0055 — Peg policy bucket controller recovers authoritative IAM reconciliation

**Status:** Accepted (Jul 2026), recovery complete. The temporary bootstrap was
removed after reconciliation; protected publication and the generation-pinned
runtime attachment then completed.
**Scope:** terraform/infra

## Context

ADR 0054 placed the private, generation-pinned Peg policy artifact in
`mento-monitoring` and used authoritative IAM policies for its policy and
access-log buckets. It explicitly relied on the protected org-Terraform
project Owner to reconcile bucket metadata and IAM, so it rejected an
additional controller role.

Post-apply verification disproved that operational assumption. The normal
Terraform path needs direct bucket metadata and IAM-policy authority to
reconcile both authoritative policies. Using project Owner or organization IAM
administrator access for routine reconciliation would make emergency authority
the normal path. Granting Storage Admin would restore broad authority that the
foundation removed.

Creating a narrow replacement role cannot itself repair the policy lockout. A
one-time project-level binding may be needed to let the org-Terraform identity
write both authoritative bucket policies. That bootstrap is an emergency
recovery exception, not a retained project-level grant.

## Decision

- Create `pegPolicyBucketController` in `mento-monitoring` with only
  `storage.buckets.get`, `storage.buckets.getIamPolicy`,
  `storage.buckets.setIamPolicy`, and `storage.buckets.update`.
- Bind that role to `serviceAccount:${var.terraform_service_account}` only in
  the two authoritative Peg bucket IAM policies. The contract rejects every
  other use of the role.
- Treat that bucket-scoped binding as the normal reconciliation path. The
  protected org-Terraform project Owner and organization IAM administrators
  remain audited emergency exceptions.
- Permit a project-level binding of this exact custom role only for an
  explicitly approved, time-bounded recovery. Create the custom role with a
  targeted `-refresh=false` operation, add the temporary binding, apply the
  full platform stack, remove the binding immediately after both bucket policies
  reconcile, verify its absence, and run a clean full plan.
- Do not use `roles/storage.admin`, Storage Object Admin, or Service Account
  User as a bootstrap or fallback. For any future recovery, do not resume
  policy publication, runtime attachment, or alert activation until it records
  the clean plan.

## Recovery procedure

From clean current `main`, record explicit approval and the temporary grant's
expiry. The target plan must add only the custom role. Terraform marks this
exact target plan `complete: false`; the guard accepts that incomplete envelope
only for this recovery target and its exact create action.

```bash
pnpm tf plan platform -- -refresh=false -target=google_project_iam_custom_role.peg_policy_bucket_controller
pnpm tf apply platform -- -auto-approve -refresh=false -target=google_project_iam_custom_role.peg_policy_bucket_controller
gcloud projects add-iam-policy-binding mento-monitoring \
  --member="serviceAccount:org-terraform@mento-terraform-seed-ffac.iam.gserviceaccount.com" \
  --role="projects/mento-monitoring/roles/pegPolicyBucketController"
pnpm tf plan platform
pnpm tf apply platform -- -auto-approve
```

After both bucket policies reconcile, remove the project grant immediately:

```bash
gcloud projects remove-iam-policy-binding mento-monitoring \
  --member="serviceAccount:org-terraform@mento-terraform-seed-ffac.iam.gserviceaccount.com" \
  --role="projects/mento-monitoring/roles/pegPolicyBucketController"
gcloud projects get-iam-policy mento-monitoring \
  --flatten="bindings[].members" \
  --filter="bindings.role:projects/mento-monitoring/roles/pegPolicyBucketController AND bindings.members:serviceAccount:org-terraform@mento-terraform-seed-ffac.iam.gserviceaccount.com" \
  --format="value(bindings.members)"
pnpm tf plan platform
```

The IAM query must print nothing and the full plan must be clean before policy
publication resumes. Preserve the target plan, full apply, removal, absence
check, and clean plan as recovery evidence.

[ADR 0061](0061-exact-plan-guard-for-manual-platform-applies.md) makes this the
only platform target exception. The wrapper inspects the entire managed diff
and accepts it only when the custom role is the sole non-no-op resource and its
action is create. It then applies the exact checked plan.

## Alternatives considered

- **Keep using Owner or organization IAM admin access** — rejected because
  emergency authority would become the routine reconciliation path and obscure
  the exact permissions Terraform needs.
- **Grant `roles/storage.admin`** — rejected because it restores project-wide
  storage authority beyond the two policy buckets.
- **Retain the project-level custom-role bootstrap** — rejected because the
  durable bucket-policy bindings replace it after reconciliation.
- **Use separate bucket IAM member resources** — rejected because the two
  authoritative policy documents intentionally own their complete direct grant
  sets.

## Consequences

- The recovery adds a four-permission custom role and two direct bindings; it
  does not broaden the runtime, publisher, Cloud Run, or alert authority.
- The one-time bootstrap remains an operator action outside Terraform state,
  so its removal, live absence check, and clean full plan are mandatory
  evidence.
- The completed recovery preserved least privilege and unlocked protected policy
  publication and runtime attachment; Grafana activation remains a separate
  reviewed apply.

## Evidence

- Same-project foundation and amendment history:
  [ADR 0054](0054-same-project-peg-policy-artifact.md)
- Controller and authoritative policies:
  [`terraform/peg-policy.tf`](../../terraform/peg-policy.tf)
- Fail-closed regression contract, split by concern under
  `scripts/production-infra-identity-contract/` and reached through
  [`index.mjs`](../../scripts/production-infra-identity-contract/index.mjs):
  [`peg-policy-constants.mjs`](../../scripts/production-infra-identity-contract/peg-policy-constants.mjs),
  [`peg-policy-bucket.mjs`](../../scripts/production-infra-identity-contract/peg-policy-bucket.mjs),
  [`peg-policy-publication.mjs`](../../scripts/production-infra-identity-contract/peg-policy-publication.mjs),
  and
  [`peg-policy-runtime.mjs`](../../scripts/production-infra-identity-contract/peg-policy-runtime.mjs).
  They parse HCL through the shared
  [`scripts/lib/hcl.mjs`](../../scripts/lib/hcl.mjs) core
  ([ADR 0064](0064-scripts-module-directories.md)); the assertions themselves are
  unchanged.
- Recovery runbook: [`docs/terraform.md`](../terraform.md)
- Issue: [#1444](https://github.com/mento-protocol/monitoring-monorepo/issues/1444)
