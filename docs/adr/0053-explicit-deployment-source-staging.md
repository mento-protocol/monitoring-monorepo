---
title: Routine GCP deploys use explicit source-staging buckets
status: active
owner: eng
canonical: true
last_verified: 2026-07-27
scope: terraform/infra
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0053 — Routine GCP deploys use explicit source-staging buckets

**Status:** Accepted (Jul 2026), phase A infrastructure source prepared;
current-main apply, phase B routing, canaries, and broad-role removal remain
separate gates.
**Scope:** terraform/infra

## Context

Metrics Bridge and Grafana Alloy submit Cloud Build jobs, while Aegis and the
Alloy build deploy App Engine services. These commands previously let `gcloud`
find or create its default source bucket. That lookup made routine deployers
depend on project-wide `roles/storage.admin`, even though each deploy only
needs one short-lived source bucket.

Cloud Build and App Engine do not use staging in the same way. Cloud Build
uploads a uniquely named archive. App Engine lists a content-addressed cache
and can re-upload, replace, or clean up a hash-named object near lifecycle
expiry. App Engine also requires a `US`-compatible bucket for the immutable
`us-central` application, while Metrics Bridge builds run in `var.gcp_region`.

The Alloy Cloud Build path is pinned to the dedicated
`grafana_agent_builder` service account. Recent Metrics Bridge builds use the
project's default Compute service account
`80554359692-compute@developer.gserviceaccount.com`. Both are exact Cloud
Build source executors. The legacy
`80554359692@cloudbuild.gserviceaccount.com` identity is not a source-staging
principal and has no Alloy Secret Manager access.

## Decision

The platform stack owns two private, uniform-access staging buckets:

- `<project>-cloud-build-source` in `var.gcp_region`, with live objects deleted
  after 7 days;
- `<project>-app-engine-source` in `US`, with live objects deleted after 30
  days so App Engine can reuse its content-addressed cache.

Both buckets enforce public-access prevention, disable soft-delete retention,
set `force_destroy = false`, and use Terraform `prevent_destroy`. Their
contents are reconstructible deployment input, not durable records.

The follow-up routing phase makes every executable deploy path name its bucket:

- `gcloud builds submit` uses `--gcs-source-staging-dir`;
- `gcloud app deploy` uses `--bucket`;
- the nested Alloy Cloud Build writes logs only to Cloud Logging.

Cloud Build callers — the routine deployer and `gcp_dev_members` — receive
bucket metadata read plus object create on the Cloud Build bucket. Its exact
executors — the dedicated `grafana_agent_builder` and Metrics Bridge's verified
default Compute service account — receive object view there. App Engine
uploaders — those callers plus that builder — receive bucket metadata read plus
object admin on the App Engine bucket. AppSpot receives object view. No staging
grant is project-wide.

Metrics Bridge's default Compute executor is not an App Engine uploader. It has
read-only access to the Cloud Build source bucket and no grant on the App Engine
source bucket.

The routine deployer and `gcp_dev_members` receive Service Account User on the
exact default Compute Engine service account used by the unpinned Metrics
Bridge Cloud Run service. This preserves both the automated Metrics Bridge
rollout and the supported direct `pnpm bridge:deploy` path after the broad
fallback is removed. The existing exact AppSpot binding continues to cover
Aegis.

This first phase is additive. Existing project-wide Storage Admin and routine
Service Account User grants remain until real Metrics Bridge, Aegis, and Alloy
deploys prove the explicit paths. A later reviewed phase removes those broad
grants and audits effective project, bucket, inherited, and service-account
IAM. It must finish before the protected peg-policy bucket is created.

Land the infrastructure as its own PR. After it merges, refresh current `main`,
run a clean current-main platform plan, get explicit apply approval, apply, and
verify the live buckets and IAM. Only then merge the routing follow-up. That
follow-up triggers the Metrics Bridge and Aegis deploy workflows; reversing the
order makes both automatic deploys race missing infrastructure and fail closed.

## Alternatives considered

- **Keep default buckets and project-wide Storage Admin** — rejected because a
  routine service deploy does not need authority over every project bucket.
- **Use one shared staging bucket** — rejected because the services require
  different locations, retention windows, and write permissions.
- **Give App Engine uploaders object create only** — rejected because App
  Engine's source cache can replace or remove an existing hash-named object.
- **Pass `gcloud app deploy --no-cache`** — rejected because it controls the
  build cache, not the source-bucket listing and upload path, and would discard
  useful build reuse.
- **Remove the broad grants in the same apply** — rejected because the
  replacement paths need live canary proof first and Terraform cannot prove
  the external deploy behavior.

## Consequences

- Routine source uploads have a small, named storage boundary that future
  sensitive buckets cannot inherit.
- App Engine uploaders retain stronger object authority, but only on a
  short-lived source bucket.
- The dedicated Alloy builder and Metrics Bridge's verified default Compute
  executor have the exact staging grants they need; the legacy default Cloud
  Build identity remains outside the staging-principal set.
- The routing phase adds a checked-in contract that discovers every executable
  submit/deploy callsite and rejects a new one unless it names the correct
  staging bucket.
- Operators must preserve the phase boundary: merge and apply the additive
  infrastructure from current `main`, merge routing, run all deploy canaries,
  then remove broad roles in a separate approved platform apply. This ADR
  creates no peg-policy bucket or identity.

## Evidence

- Bucket and IAM ownership:
  [`terraform/deploy-staging.tf`](../../terraform/deploy-staging.tf)
- [Cloud Build source staging reference](https://cloud.google.com/sdk/gcloud/reference/builds/submit)
- [App Engine deployment bucket reference](https://cloud.google.com/sdk/gcloud/reference/app/deploy)
- [Cloud Storage IAM roles](https://cloud.google.com/storage/docs/access-control/iam-roles)
- [Issue #1444](https://github.com/mento-protocol/monitoring-monorepo/issues/1444)
