---
title: Routine GCP deploys use explicit source-staging buckets
status: active
owner: eng
canonical: true
last_verified: 2026-08-10
scope: terraform/infra
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0053 — Routine GCP deploys use explicit source-staging buckets

**Status:** Accepted (Jul 2026). The source-staging foundation, routing,
canaries, and broad-role removal are complete. The bucket decision remains in
force; [ADR 0058](0058-metrics-bridge-dedicated-cloud-build-executor.md)
supersedes the Metrics Bridge executor choice through a separate phased
migration.
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
`grafana_agent_builder` service account. ADR 0058's applied foundation provides
the dedicated Metrics Bridge replacement, and the checked-in config pins
`metrics-bridge-builder`. The current default Compute source reader remains
temporarily through the GitHub and direct `main` canaries. The legacy
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

The completed routing phase makes every executable deploy path name its bucket:

- `gcloud builds submit` uses `--gcs-source-staging-dir`;
- `gcloud app deploy` uses `--bucket`;
- the nested Alloy Cloud Build writes logs only to Cloud Logging.

Cloud Build callers — the routine deployer and `gcp_dev_members` — receive
bucket metadata read plus object create on the Cloud Build bucket. Its dedicated
executors — `grafana_agent_builder` and `metrics-bridge-builder` — receive
object view there. Default Compute retains its legacy read-only source access
only through ADR 0058's two route canaries, then a separate approved cleanup
apply removes it. App Engine
uploaders — those callers plus that builder — receive bucket metadata read plus
object admin on the App Engine bucket. AppSpot receives object view. No staging
grant is project-wide.

Metrics Bridge's default Compute executor is not an App Engine uploader. Its
temporary Cloud Build source access never grants access to the App Engine source
bucket.

The routine deployer and `gcp_dev_members` receive Service Account User on the
dedicated Metrics Bridge runtime identity. ADR 0058 additionally grants them
Service Account User on the dedicated builder only; neither receives
default-Compute act-as. The existing exact AppSpot binding continues to cover
Aegis.

The source-staging migration was deliberately additive. It first retained the
project-wide Storage Admin, Storage Object Admin, and routine Service Account
User grants while all five deployment paths proved the explicit routes. ADR
0054's later reviewed foundation removed those broad grants after the canaries;
the effective project, bucket, inherited, and service-account IAM audits are
complete. ADR 0055 records the bounded controller recovery used before policy
publication resumed.

ADR 0058 reuses that sequencing rule for the Metrics Bridge builder. Its
additive identity foundation is applied and verified, and the build config now
selects it. Complete both canaries while default Compute retains its temporary
reader, then remove it in a separate reviewed cleanup PR and approved apply.

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
- **Maintain general shell and JavaScript invocation parsers for callsite
  discovery** — rejected because five approved calls do not justify owning
  those language semantics. The bounded lexical and AST recovery covers the
  checked-in direct forms. It does not interpret indirect
  `Function.prototype.call`/`apply`; supporting those forms, inert examples, or
  native comment masking would expand the partial parser.

## Consequences

- Routine source uploads have a small, named storage boundary that future
  sensitive buckets cannot inherit.
- App Engine uploaders retain stronger object authority, but only on a
  short-lived source bucket.
- The dedicated Alloy and Metrics Bridge builders have exact staging grants.
  Default Compute retains a temporary read-only source grant only until both
  Metrics Bridge route canaries pass; the legacy default Cloud Build identity
  remains outside the staging-principal set.
- A checked-in contract allows exactly five literal checked-in submit/deploy
  callsites and their required source-staging flag/value. Discovery rejects
  additional deploy records recovered from shell-like surfaces, wrappers,
  generated scripts, Dockerfiles, structured configuration, and Terraform
  outside comments. Node/TypeScript recovery covers direct call/new expressions
  with inline literals or supported `const`/object aliases, plus static tagged
  templates. Indirect `Function.prototype.call`/`apply`, dynamically constructed
  executables, and dynamic paths are forbidden but outside the static proof.
  Native PowerShell block comments and batch `REM`/`::` lines are deliberately
  not masked, so deploy-shaped text there fails closed. A statically selected
  cmd shell preserves `#` as executable text; known Unix and PowerShell shells
  retain their native `#` comment behavior. Inert examples belong only in
  `scripts/deploy-staging-contract.test.mjs`.
- The original source-staging phase boundary is complete. ADR 0058 adds a
  separate applied-foundation, routing-canary, then cleanup sequence for the
  Metrics Bridge builder. This ADR itself creates no peg-policy bucket or
  identity.

## Evidence

- Bucket and IAM ownership:
  [`terraform/deploy-staging.tf`](../../terraform/deploy-staging.tf)
- [Cloud Build source staging reference](https://cloud.google.com/sdk/gcloud/reference/builds/submit)
- [App Engine deployment bucket reference](https://cloud.google.com/sdk/gcloud/reference/app/deploy)
- [Cloud Storage IAM roles](https://cloud.google.com/storage/docs/access-control/iam-roles)
- [Issue #1444](https://github.com/mento-protocol/monitoring-monorepo/issues/1444)
