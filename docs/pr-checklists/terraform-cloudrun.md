---
title: Terraform and Cloud Run Checklist
status: active
owner: eng
canonical: true
last_verified: 2026-08-13
doc_type: checklist
scope: terraform/infra
review_interval_days: 90
garden_lane: pr-checklists-process
---

# Terraform + Cloud Run checklist

Use this checklist for any change to `terraform/` or to a deploy script that talks to GCP. Infra mistakes can wedge the apply, briefly drop public access, or block first-bootstrap of a new environment — all of which surface days later when nobody remembers the PR.

## Operating rule

> **Every project-level mutation must be ordered behind the IAM owner binding, and every Cloud Run knob must work on bootstrap, on re-apply, AND on workflow-dispatch retry.**

## 1. Resource refactors and retirement

When you rename a resource, change its address (e.g. remove `count`/`for_each`, move it into a module), or split one resource into two:

- [ ] Add a `moved` block for every old → new address. Without it, `terraform apply` plans a destroy + create, which:
  - Fails immediately if the resource has `deletion_protection = true` (Cloud Run services in this repo do)
  - Briefly destroys IAM members, revoking public access for the duration of the apply
  - Loses any drift the team accepted out-of-band (e.g. an image rolled by `gcloud run services update`)
- [ ] When Terraform should stop managing an object but the remote object must
      survive, replace its resource block with a `removed` block whose
      `lifecycle` sets `destroy = false`. Simply deleting the resource block
      plans remote destruction. `removed` blocks require Terraform 1.7 or
      newer; raise the owning root's `required_version` when needed.
- [ ] Find the owning stack with `pnpm tf list` or
      `terraform.stacks.json`, then run `pnpm tf plan <owning-stack>`.
      `pnpm infra:plan` is only an alias for the `platform` stack. Confirm the
      plan shows the intended move or state removal and no unintended
      `# ... will be destroyed` action.

Current examples are the metrics-bridge `moved` blocks in
`terraform/metrics-bridge.tf` and the state-only retirement in
`terraform/dashboard.tf`.

## 2. Cloud Run service shape

For every `google_cloud_run_v2_service`:

- [ ] Probe paths use `/health`, NOT `/healthz`. Cloud Run v2 reserves `/healthz` at the frontend, so external `/healthz` returns a Google-branded 404
- [ ] Memory ≥ `512Mi` if `cpu_idle = false` (always-allocated CPU floor)
- [ ] `lifecycle.ignore_changes` covers `template[0].containers[0].image` and provider-visible Cloud Run API bookkeeping drift (`client`, `client_version`, `scaling[0].manual_instance_count`, `scaling[0].min_instance_count`) when rollouts happen out-of-band via `gcloud run services update` (otherwise `terraform apply` reverts the image or reapplies cosmetic deploy metadata). Child ignore paths under the optional service-level `scaling` block require an explicit parent `scaling {}` block in configuration; without it, Terraform cannot match `scaling[0]` and plans to remove deploy-stamped zero defaults. Do not ignore the whole service-level `scaling` block, because `scaling_mode` is real runtime state. In steady state, `metrics_bridge_template_rollout_active = false` and `template[0].revision` is also ignored. Any Terraform-owned template change (`env`, probes, resources, service account, or `template[0].scaling`) sets the marker to `true` and removes only the revision ignore in the same PR. Provider 6.50 can otherwise send the retained old name with changed template content and receive Cloud Run HTTP 409. After the approved apply and runtime proof, an immediate stabilization PR restores the marker to `false` and the revision ignore; it needs no apply. Pause unrelated full platform applies while the marker is `true`. If apply or proof fails, complete or explicitly roll back the template change under a new reviewed plan before stabilization.
- [ ] Run the platform wrapper and confirm its exact-plan policy reports the
      expected `stable` or `rollout` mode. It checks the saved plan, so a
      tfvar-driven template change cannot bypass the source marker. Never use
      raw `terraform plan/apply` to bypass this check. See
      [ADR 0061](../adr/0061-exact-plan-guard-for-manual-platform-applies.md).
- [ ] Default/bootstrap `image` MUST be pinned and respond to the configured
      probe path. The current digest-pinned `gcr.io/cloudrun/hello` image uses a
      catch-all handler and therefore serves `/health`; re-verify this contract
      before replacing it
- [ ] `depends_on = [google_project_service.run]` so `run.googleapis.com` is enabled before service creation

## 3. Cloud Run revision suffix (`--revision-suffix`)

Cloud Run revision names follow RFC 1035: must start with a lowercase letter `[a-z]`, then `[a-z0-9-]{0,61}`, end with `[a-z0-9]`. They MUST also be unique per revision.

- [ ] Suffix MUST start with a lowercase letter. A raw 7-char git SHA starts with a hex digit ~62% of the time and fails the deploy. Prefix with a letter (e.g. `r-${GITHUB_SHA::7}-${GITHUB_RUN_ID}`)
- [ ] Suffix MUST be unique across runs. Deriving solely from the commit SHA collides on `workflow_dispatch` retry — append a per-run disambiguator (`$GITHUB_RUN_ID` in CI, `$(date +%s)` in scripts)

Current call sites to verify any new deploy path against:

- the `gcloud run services update` step in
  `.github/workflows/metrics-bridge.yml`
- the matching rollout in `scripts/deploy/deploy-bridge.sh`

## 4. Cloud Build source context

For every deploy path that uses `gcloud builds submit`, a Dockerfile, or another
trimmed build context:

- [ ] Dockerfile `COPY` steps include every package-manager and build input
      needed before install/build. Root pnpm `patchedDependencies` makes
      `patches/**` load-bearing; copy it before every `pnpm install` stage.
- [ ] `.gcloudignore` does not exclude those same inputs. Keep it aligned with
      the Dockerfile and any workspace packages the build needs before install
      (for example `shared-config/` for metrics-bridge).
- [ ] Terraform `archive_file` sources exclude local-only outputs produced by
      commands run in the source root (especially `coverage/`), and
      `.gcloudignore` mirrors those exclusions. Run the representative local
      commands before the final plan and confirm transient files do not replace
      the source object or Cloud Function.
- [ ] Deploy workflow `paths:` filters include those inputs so patch-only or
      build-context-only changes actually redeploy (`patches/**`, lockfiles,
      package manifests, `cloudbuild.yaml`, Dockerfile, and any workspace deps the
      deploy image consumes).
- [ ] Validate build-context fixes with the real build backend, e.g.
      `gcloud builds submit --config=cloudbuild.yaml ...`. Local package tests and
      `pnpm install` prove dependency resolution, but they do not prove a reduced
      Cloud Build upload/Docker context contains the same files.
- [ ] The approved `gcloud builds submit` / `gcloud app deploy` callsites use
      their required source-staging flag/value. Run `pnpm tf:test`; apply
      [ADR 0053](../adr/0053-explicit-deployment-source-staging.md) for the
      supported static syntax and deliberate proof limits.
- [ ] Bucket-scope upload IAM: Cloud Build callers get bucket read/object create,
      build identities get object view, and App Engine uploaders get bucket
      read/Object Admin.
- [ ] App Engine uploaders and the default AppSpot service account get Storage
      Admin only on the service-owned `staging.<project>.appspot.com` bucket.
      Do not widen them to project scope or the Terraform-managed source
      buckets.
- [ ] After an approved apply changes App Engine staging IAM, dispatch the Aegis
      App Engine workflow from clean current `main` and require success on that
      exact head. Verify the new Aegis version serves 100% of traffic,
      `/metrics` responds with a new `process_start_time_seconds`, and
      `lastUpdatedAt` advances; then rerun the full platform plan and require no
      changes.
- [ ] Use `CLOUD_LOGGING_ONLY` unless a retained log bucket exists.

## 5. IAM ordering + dependencies

This bit me on PRs #197 and #200 — both P1 blockers.

- [ ] Project-level resources written by an impersonated SA MUST `depends_on` the binding that grants the org-terraform SA owner on the bootstrap project. Don't assume Terraform's implicit graph picks this up; the dependency is on a foreign-managed binding
- [ ] CI/CD deployer SAs need `roles/iam.serviceAccountTokenCreator` on the runtime SA they impersonate. Without it, Workload Identity Federation (`google-github-actions/auth`) fails at `getAccessToken` time before any Terraform/gcloud command runs
- [ ] Any new `google_project_iam_member` should be reviewed against the API enablement and SA bindings already present, not added as an isolated grant

## 6. Variable and Terraform-version validation

For variables that gate critical behavior:

- [ ] Add a `validation` block for non-empty strings (image refs, project IDs, region). An empty string forwarded to a required field fails the apply with a cryptic error and blocks unrelated infra changes
- [ ] If a previous schema accepted an empty value as "disable this resource", normalize it back to a safe default (or fail loudly with a migration message) — silent breakage of previously-valid `terraform.tfvars` is a hostile change
- [ ] When adopting a Terraform CLI feature, check its minimum version and
      raise the owning root's `required_version` to match. Provider write-only
      resource arguments such as `*_wo` require Terraform 1.11 or newer; CI
      using a newer binary does not prove every version allowed by the root can
      plan the configuration.

## 7. Build-artifact retention

New GCP project, Cloud Function, or versioned-bucket stacks ship WITH retention — auto-created build resources grow unbounded otherwise (PR #835: 64 images / ~1.9 GB had silently accumulated in governance-watchdog's `gcf-artifacts`).

- [ ] Gen2 Cloud Functions / Cloud Build stacks own their auto-created `gcf-artifacts` repo in Terraform (one-time `import` block, deleted right after the adopting apply) with `cleanup_policies`: `DELETE` older-than + `KEEP` most-recent-versions. Checkov's CMEK finding (CKV_GCP_84) gets an inline skip — the repo is Cloud-Functions-managed and CMEK would force recreation
- [ ] Versioned GCS buckets have a `lifecycle_rule`. Use age-based `days_since_noncurrent_time` with `with_state = "ARCHIVED"`, NOT `num_newer_versions`, when object names embed a content hash — each deploy writes a new name, so an old name's archived generation never gains newer versions and a generation-count condition never fires (it also counts the live version)
- [ ] Reconstructible source buckets set age expiry, explicit soft delete,
      `force_destroy = false`, and `prevent_destroy`.

## 8. Pre-apply rituals

- [ ] Run `pnpm tf plan <owning-stack>` ALWAYS before apply; read every
      `# ... will be destroyed` line
- [ ] If the plan touches `google_cloud_run_v2_service`, double-check that image/API bookkeeping drift is ignored and probe paths still match the deployed app
- [ ] After apply, hit the public URL once and confirm a 200 from `/health` — Cloud Run can return 503s for ~30s while the new revision rolls

## 9. Lessons already paid for

Each incident is why the section it names exists; that section, not this list,
states the current requirement.

- PR #199 — `/healthz` 404 on Cloud Run v2; bridge health moved to `/health` (§2)
- PR #197 — bootstrap IAM gated API enablement but not the project-level
  grants the impersonated SA needed (§5)
- PR #198 — `256Mi` rejected under `cpu_idle = false` (§2)
- PR #200 — Workload Identity Federation failed at `getAccessToken`, missing
  `roles/iam.serviceAccountTokenCreator` (§5)
- PR #201 — `count` removed without `moved` blocks, against a
  `deletion_protection = true` service (§1)
- PR #835 — `gcf-artifacts` retention, and the `num_newer_versions` rule that
  never fires for hash-named zips (§7)
- PR #995 — metrics-bridge Cloud Build missed `patches/`
  (`patches/@lhci__utils@0.15.1.patch`) in the Docker context and the deploy
  workflow path filter (§4)
