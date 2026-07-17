---
title: Terraform CI/CD hardening — declined alternatives
status: archived
owner: eng
canonical: false
last_verified: 2026-07-17
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

The two alternatives below were deliberately declined. They remain here so a
future change in constraints can reopen the decision without treating it as
forgotten work.

## Declined: full-refresh read-only planning for alerts delivery

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

Reopen this only under a stated invariant that no unattended CI job may hold
write credentials, such as a new audit requirement or a material expansion in
what auto-applies.

## Declined: saved-plan binding via KMS

The hardening audit considered encrypting a binary `tfplan` with KMS to recover
byte-for-byte binding between the reviewed plan and apply. It was declined
because these alerting stacks change infrequently, their blast radius is
recoverable, and the environment-gated apply path re-plans before mutation.

The prerequisite for reconsidering saved-plan binding is a higher-blast-radius
stack moving to auto-apply, or loss of healthy scheduled drift detection for an
auto-applied stack. Without one of those changes, the added artifact, key, and
decryption machinery is not justified.
