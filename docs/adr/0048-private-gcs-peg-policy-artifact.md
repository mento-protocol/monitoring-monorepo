---
title: Peg policy is a generation-pinned private GCS artifact
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
scope: metrics-bridge / alerts / terraform/infra
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0048 — Peg policy is a generation-pinned private GCS artifact

**Status:** Accepted (Jul 2026), dormant runtime support only. Production
hosting and activation wait for the Terraform identity bootstrap and cutover
tracked in #1566.
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

The Terraform identity bootstrap in #1566 separates routine deploy, PR-plan,
trusted-main refresh, and production-apply authority. Provisioning the policy
plane before that cutover, live proof, legacy-authority removal, queue drain,
and final IAM audit would create infrastructure inside the authority window
that the bootstrap is designed to close.

## Decision

- Runtime authentication lands dormant. Production sets neither
  `PEG_POLICY_URL` nor `PEG_POLICY_AUTH_MODE` in this change. The isolated Peg
  loop stays dormant while both values are absent; a missing, invalid, or
  mismatched pair fails only that loop.
- A later platform change owns a dedicated private GCS bucket, object
  versioning and retention, public-access prevention, uniform bucket-level
  access, destructive-change protection, and a dedicated Metrics Bridge
  runtime service account. That account receives only
  `roles/storage.objectViewer` on the policy bucket.
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
  protected production chain established by #1566.
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

## Consequences

- This runtime capability can merge and deploy without activating Peg polling.
- Infrastructure work remains blocked on completion evidence for #1566.
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
  #1566.
