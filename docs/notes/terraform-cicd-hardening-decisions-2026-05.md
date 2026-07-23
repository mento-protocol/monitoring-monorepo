---
title: Terraform CI/CD hardening — declined alternatives
status: archived
owner: eng
canonical: false
last_verified: 2026-07-23
doc_type: note
scope: terraform/infra
review_interval_days: 365
garden_lane: notes-plans-archive
---

# Terraform CI/CD hardening — declined alternatives

This is a historical decision record from the 2026-05 Terraform hardening
workstream. Everything actionable in that workstream shipped. Current plan and
apply behavior belongs in
[`ADR 0029`](../adr/0029-ci-apply-production-infra-gate.md),
[`docs/terraform.md`](../terraform.md), and
[`terraform-secret-strategy-2026-07.md`](terraform-secret-strategy-2026-07.md).

The alternatives below were deliberately declined. The first was reopened in
July 2026 under a stricter identity invariant; the historical rejection remains
here to show why the replacement does not broaden the PR trust boundary.

## Reopened for trusted main only: full-refresh read-only planning

The alerts-delivery stack could not use the state-only plan identity for a
full-refresh plan: refreshing its Google-provider resources requires project
read access, while that identity intentionally has access only to read the
Terraform state object.

- **Same-repository PR plans:** granting project read to an identity reachable
  by checked-out PR code would widen the PR attack surface. The accepted
  limitation is a targeted, secretless, no-refresh PR plan; trusted main and
  apply paths remain authoritative.
- **Scheduled drift:** a dedicated drift-only identity with a hand-scoped read
  role was considered and declined on cost/benefit. Its role would need to
  track the stack's resource set, while apply jobs would still require the
  write deployer and pinned shared actions.

That invariant changed in July 2026. [ADR 0047](../adr/0047-separated-terraform-ci-identities.md)
requires unattended trusted-`main` plans and scheduled drift to carry no write
credentials, while production apply authentication must prove immutable
repository ID `1172025835`, the expected repository slug, protected `main` ref,
and the `production-infra` environment through a dedicated WIF pool.

The reopened design creates a separate main-ref refresh chain rather than
broadening the PR identity. Its downstream seed service account receives a
curated non-basic project read-role set in the target projects. The guaranteed
core includes Browser, IAM Security Reviewer, and Storage Bucket Viewer, with
additional service-specific readers enumerated by each owning stack. Secret
Accessor remains limited to Terraform-managed secrets, and Storage Object
Viewer remains limited to the Cloud Function deployment-source buckets. Basic
Viewer is deliberately absent because its convenience-group behavior would
grant object reads on uniform-bucket-level-access buckets. The result supports
faithful provider refresh at an explicit confidentiality cost: trusted-main CI
can see IAM policy, service data such as logs, metrics, and Artifact Registry
contents, managed secret payloads, and deployment source. It cannot mutate
those resources, cannot read replay/rotation-state/log bucket objects through
the targeted GCS grants, and cannot be impersonated by PR refs. A live full
refresh-only plan, not configuration validation alone, must prove the curated
permissions through the checked-in routing cutover before final authority
removal.

## Declined: saved-plan binding via KMS

The hardening audit considered encrypting a binary `tfplan` with KMS to recover
byte-for-byte binding between the reviewed plan and apply. It was declined
because these alerting stacks change infrequently, their blast radius is
recoverable, and the environment-gated apply path re-plans before mutation.

The prerequisite for reconsidering saved-plan binding is a higher-blast-radius
stack moving to auto-apply, or loss of healthy scheduled drift detection for an
auto-applied stack. Without one of those changes, the added artifact, key, and
decryption machinery is not justified.
