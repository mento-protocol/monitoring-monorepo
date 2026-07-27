---
title: Peg policy is a generation-pinned private GCS artifact
status: active
owner: eng
canonical: true
last_verified: 2026-07-27
scope: metrics-bridge / alerts / terraform/infra
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0048 — Peg policy is a generation-pinned private GCS artifact

**Status:** Accepted (Jul 2026), dormant runtime support and unapplied source
foundation only. Production hosting and activation remain separate steps.
**Scope:** metrics-bridge / alerts / terraform/infra

## Context

[ADR 0044](0044-peg-thresholds-gated-rules-plane.md) keeps page-affecting Peg
policy behind the `production-infra` gate. The bridge must read the approved
policy at runtime without baking it into an ordinary service image.

The policy is not secret. Public hosting would still create an unnecessary
distribution surface. Signed URLs would turn stable configuration into
expiring bearer credentials. An unpinned `current.json` URL could also return
different bytes under one runtime configuration after an overwrite or
rollback.

ADR 0047 separates routine deploy, PR-plan, trusted-main refresh, and
production-apply authority. The legacy authority removal, run drain, and IAM
audit are complete. The policy plane still requires its own reviewed,
human-approved platform plan and apply before it exists in production.

## Decision

- Runtime authentication lands dormant. Production sets neither
  `PEG_POLICY_URL` nor `PEG_POLICY_AUTH_MODE` in this change. The isolated Peg
  loop stays dormant while both values are absent; a missing, invalid, or
  mismatched pair fails only that loop.
- The dormant Terraform source foundation creates the
  `mento-monitoring-peg-policy` project under the monitoring project's
  organization and billing account. Terraform explicitly manages only Storage
  and IAM service enablement there; Google project-bootstrap services are not
  part of the application surface. The policy bucket, access-log bucket, and
  publisher service account live in that project. The runtime service account
  remains in `mento-monitoring` for its later Cloud Run attachment and receives
  one cross-project bucket grant. Routine deploy, PR-plan, trusted-main refresh,
  and developer identities receive no role in the dedicated project.
- The policy bucket uses versioning, public-access prevention, uniform
  bucket-level access, and Terraform destructive-change protection. Cloud
  Storage automatically deletes a generation only after it has stayed
  noncurrent for 30 days. That lifecycle rule does not stop the publisher's
  `roles/storage.objectAdmin` grant from deleting current or retained objects
  directly. The exact direct bucket policy grants the runtime only
  `roles/storage.objectViewer` and the publisher only
  `roles/storage.objectAdmin`.
- Protected org-Terraform bootstraps the dedicated project with a direct
  project Owner grant. A bucket-scoped custom role also lets it read and
  replace each bucket policy and update bucket metadata. That metadata authority
  includes retention, versioning, logging, uniform-access, and public-access
  settings; Terraform review and reconciliation protect those settings, not the
  custom role itself. The Owner grant can also change project IAM. These are
  intentional protected control-plane exceptions.
- The access-log bucket's exact direct policy contains only the protected
  controller and the Google Storage analytics writer. It retains LIVE objects
  for 90 days and noncurrent ARCHIVED objects for 30 days. Logs are audit
  telemetry, never an authorization control.
- Project separation removes monitoring-project roles and service agents from
  the policy plane, but organization-level grants still inherit. The accepted
  exceptions are the protected org-Terraform path and organization IAM
  administrators. The current organization policy also gives org-Terraform
  inherited `roles/storage.objectViewer`. The policy is non-secret, so that
  audited protected read path is acceptable; an inherited routine writer is
  not. Audit effective readers, writers, and IAM administrators before apply
  and activation.
- The alerts-rules stack owns `peg-policy/current.json`. Its bytes come
  directly from `alerts/rules/peg-thresholds.json`, so the protected apply that
  owns paging policy also creates each new GCS object generation.
- Runtime configuration pins that immutable generation. `PEG_POLICY_URL` must
  be the canonical GCS JSON download endpoint:
  `https://storage.googleapis.com/download/storage/v1/b/{bucket}/o/{encoded-object}?alt=media&generation={generation}`.
  The object name is one canonical percent-encoded path component and the
  generation is a positive GCS `int64`; `alt` then `generation` is the only
  accepted query order. Credentials, fragments, alternate
  hosts, ports, redirects, missing generation, and extra or duplicate query
  keys are rejected before credential acquisition.
- `PEG_POLICY_AUTH_MODE=gcp-metadata` is the production mode. The bridge
  obtains a short-lived OAuth bearer token from the GCE metadata server using
  `Metadata-Flavor: Google`, validates the bounded response, and caches it only
  outside a safe expiry skew. It sends the bearer token only to a validated
  pinned GCS URL and never retries anonymously.
- `none` exists for deliberate local and test HTTPS artifacts. It requires a
  code-only opt-in that environment configuration cannot set, and it cannot be
  combined with a bearer-token provider.
- Token or policy fetch failures preserve the last accepted policy and remain
  inside the Peg loop's bounded error channel. They never affect the primary
  Hasura poller or `/health`.
- The same-repo PR-plan identity receives no policy-object read access. Future
  Terraform must keep PR planning state-only, route trusted-main refresh
  through its read-only identity, and route production apply through the
  protected production chain established by ADR 0047.
- Policy publication, runtime generation selection, producer proof, and rule
  activation remain separate reviewed steps. A new generation first retains
  the exact previous policy required by ADR 0044. The platform plan then
  updates the pinned runtime URL. Only after the producer acknowledges the new
  version may a protected follow-up remove `previous`.

## Alternatives considered

- **Public GCS object** — rejected because the runtime has a workload identity
  and needs no public reader.
- **Signed URL** — rejected because it is an expiring bearer credential with a
  separate rotation and redaction lifecycle.
- **Unpinned `current.json` media URL** — rejected because one configuration
  could return different policy bytes over time.
- **Secret Manager or a repository secret** — rejected because neither the
  policy nor its location is secret.
- **Policy baked into the bridge image** — rejected because an ordinary
  service deploy could activate page-affecting policy outside the protected
  alerts apply.
- **Default Cloud Run identity** — rejected because a dedicated bucket-scoped
  reader makes runtime authority explicit.
- **Buckets in `mento-monitoring`** — rejected because monitoring service
  agents and broad operational roles would inherit access to the policy plane.
- **Tag-scoped IAM deny policy** — rejected because tag attachment and
  propagation add a brittle create-time and recovery dependency. A small
  dedicated project gives the isolation boundary with ordinary project and
  bucket IAM.

## Consequences

- This runtime capability can merge and deploy without activating Peg polling.
- The foundation remains source-only and runtime-dormant. The dedicated project
  is the effective-isolation control; it does not make organization inheritance
  disappear.
- Before apply and activation, audit effective readers, writers, and IAM
  administrators of the dedicated project and both buckets. Any inherited
  routine writer blocks rollout. Access logs help investigate access; they
  never authorize or block policy publication or reads.
- A policy change needs a reviewed artifact generation and an explicit pinned
  runtime-configuration change. The bridge keeps producing the retained
  version until that change lands.
- Rollback is source-controlled: publish or select a reviewed policy generation
  through the owning Terraform paths. Retained GCS generations are recovery
  evidence, not permission for an ad hoc provider-CLI overwrite.

## Evidence

- Runtime enforcement:
  `metrics-bridge/src/peg/gcp-metadata-auth.ts`,
  `metrics-bridge/src/peg/policy-client.ts`, and
  `metrics-bridge/src/peg/runtime.ts`.
- Policy and rollover contract:
  `alerts/rules/peg-thresholds.json` and ADR 0044.
- Future owning surfaces:
  `terraform/`, `alerts/rules/`, and the protected Terraform workflows after
  ADR 0047's final cutover.
- Source foundation:
  `terraform/peg-policy.tf` and the production-infrastructure identity
  contract.
