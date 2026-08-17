---
title: Routine GCP deploys use explicit source-staging buckets
status: active
owner: eng
canonical: true
last_verified: 2026-08-17
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
Even with `gcloud app deploy --bucket`, App Engine writes its service-owned
`staging.<project>.appspot.com` bucket while deploying a version. Google
documents `roles/storage.admin` when that internal staging path is denied.
Aegis deploys failed on this path after the routine deployer lost project-wide
Storage Admin. A bucket-scoped AppSpot grant alone did not recover the deploy:
the rerun still failed, and its `CreateVersion` audit event identified the
routine deployer as the request principal. Both the `gcloud` caller and AppSpot
therefore need the documented permission set on this one bucket. They do not
need it at project scope.

The Alloy Cloud Build path is pinned to the dedicated
`grafana_agent_builder` service account. ADR 0058's applied foundation provides
the dedicated Metrics Bridge replacement, and the checked-in config pins
`metrics-bridge-builder`. Both Metrics Bridge route canaries passed, and the
follow-up cleanup removes default Compute's direct source-bucket Object Viewer.
Its project-level Editor role remains a separate audit and retirement task. The legacy
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
object view there. After ADR 0058's two route canaries, a separate approved
cleanup apply removes default Compute's direct Cloud Build source-bucket Object
Viewer. Its project-level Editor role may still grant inherited Storage access
and remains outside this source-staging cleanup. App Engine uploaders — those
callers plus the Alloy builder — receive bucket metadata read plus object admin
on the App Engine bucket. AppSpot receives object view. No direct staging grant
is project-wide, and default Compute has no direct App Engine source-bucket
grant in this stack.

The App Engine uploaders and default AppSpot service account also receive
`roles/storage.admin` on only `staging.<project>.appspot.com`, the App Engine
service-owned staging bucket. Cloud Storage limits these grants to that bucket
and its objects. This supported exception covers version submission and App
Engine's internal staging path; it does not apply to either Terraform-managed
source bucket or any project scope.

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
selects it. Both route canaries passed. The follow-up cleanup removes default
Compute's direct source-bucket Object Viewer through a separately reviewed and
approved apply.

## Alternatives considered

- **Keep default buckets and project-wide Storage Admin** — rejected because a
  routine service deploy does not need authority over every project bucket.
- **Use one shared staging bucket** — rejected because the services require
  different locations, retention windows, and write permissions.
- **Give App Engine uploaders object create only** — rejected because App
  Engine's source cache can replace or remove an existing hash-named object.
- **Grant only the default AppSpot service account on the service-owned staging
  bucket** — rejected because a live rerun retained the same denial after that
  grant was applied; the failed `CreateVersion` audit event named the routine
  deployer as the caller.
- **Use legacy bucket reader plus object admin for App Engine's default staging
  bucket** — rejected because Google's documented remedy for the service-owned
  staging path is Storage Admin, which is supported at the one-bucket scope.
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
- App Engine uploaders retain stronger object authority on the short-lived
  explicit source bucket and Storage Admin on only App Engine's service-owned
  staging bucket.
- The default AppSpot service account also has Storage Admin only on the
  service-owned staging bucket. No uploader or AppSpot grant is project-wide.
- The dedicated Alloy and Metrics Bridge builders have exact staging grants.
  The cleanup leaves default Compute outside the direct source-bucket Object
  Viewer set; its separate project-level Editor role remains outside this ADR.
  The legacy default Cloud Build identity remains outside the staging-principal
  set.
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
- The same contract pins the Metrics Bridge build path. Both submit callsites —
  the GitHub deploy workflow and the direct wrapper — must pass
  `--config=cloudbuild.yaml` exactly and must not override it with
  `--service-account`. That config must name the dedicated builder
  ([ADR 0058](0058-metrics-bridge-dedicated-cloud-build-executor.md)) and write
  logs only to Cloud Logging, as the Alloy build config must. The contract also
  proves the Terraform side of the grants above: the Cloud Build source-object
  readers are exactly the two dedicated builders, and the App Engine uploader
  and default AppSpot Storage Admin grants name only
  `staging.<project>.appspot.com`.
- The contract fixes the direct Metrics Bridge deploy's bootstrap shape. Before
  it builds, that wrapper reconciles the builder's project roles, Artifact
  Registry writer, developer act-as bindings, build-log reader,
  dedicated-builder source readers, and Peg-policy bucket IAM. It targets the
  two source readers by exact instance key, never their whole `for_each`
  collection, so a routine deploy cannot enact the pending sibling removal
  reserved for ADR 0058's reviewed platform apply. It fails closed on an
  existing service whose exact name it cannot verify and does not target that
  service. A first service create and an interrupted public-binding create each
  run one separate `-refresh=false` saved plan accepted by
  `check-metrics-bridge-bootstrap-plan.mjs`. Terraform state, the live service,
  and the live public invoker binding are all verified before image rollout.
- The original source-staging phase boundary is complete. ADR 0058 adds a
  separate applied-foundation, routing-canary, then direct-reader cleanup
  sequence for the Metrics Bridge builder. This ADR itself creates no peg-policy
  bucket or identity.

## Evidence

- Bucket and IAM ownership:
  [`terraform/deploy-staging.tf`](../../terraform/deploy-staging.tf)
- Direct deploy wrapper and its bootstrap plan guard:
  [`scripts/deploy-bridge.sh`](../../scripts/deploy-bridge.sh) and
  [`scripts/check-metrics-bridge-bootstrap-plan.mjs`](../../scripts/check-metrics-bridge-bootstrap-plan.mjs)
- Contract implementation, run by `pnpm tf:test`:
  [`scripts/deploy-staging-contract.mjs`](../../scripts/deploy-staging-contract.mjs)
  and
  [`scripts/deploy-staging-callsite-discovery.mjs`](../../scripts/deploy-staging-callsite-discovery.mjs).
  Both read Terraform and workflow text through the shared parsing cores
  [`scripts/lib/hcl.mjs`](../../scripts/lib/hcl.mjs) and
  [`scripts/lib/workflow-yaml.mjs`](../../scripts/lib/workflow-yaml.mjs)
  ([ADR 0064](0064-scripts-module-directories.md)). Those cores carry no policy;
  the five allowed callsites and the source-staging assertions live here.
- [Cloud Build source staging reference](https://cloud.google.com/sdk/gcloud/reference/builds/submit)
- [App Engine deployment bucket reference](https://cloud.google.com/sdk/gcloud/reference/app/deploy)
- [App Engine deployment troubleshooting](https://cloud.google.com/appengine/docs/standard/troubleshooter/deployment)
- [Cloud Storage IAM roles](https://cloud.google.com/storage/docs/access-control/iam-roles)
- [Aegis staging-access recovery issue](https://github.com/mento-protocol/monitoring-monorepo/issues/1789)
- [Issue #1444](https://github.com/mento-protocol/monitoring-monorepo/issues/1444)
