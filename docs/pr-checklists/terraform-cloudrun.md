# Terraform + Cloud Run checklist

Use this checklist for any change to `terraform/` or to a deploy script that talks to GCP. Infra mistakes can wedge the apply, briefly drop public access, or block first-bootstrap of a new environment — all of which surface days later when nobody remembers the PR.

## Operating rule

> **Every project-level mutation must be ordered behind the IAM owner binding, and every Cloud Run knob must work on bootstrap, on re-apply, AND on workflow-dispatch retry.**

## 1. Resource refactors

When you rename a resource, change its address (e.g. remove `count`/`for_each`, move it into a module), or split one resource into two:

- [ ] Add a `moved` block for every old → new address. Without it, `terraform apply` plans a destroy + create, which:
  - Fails immediately if the resource has `deletion_protection = true` (Cloud Run services in this repo do)
  - Briefly destroys IAM members, revoking public access for the duration of the apply
  - Loses any drift the team accepted out-of-band (e.g. an image rolled by `gcloud run services update`)
- [ ] Run `pnpm infra:plan` and confirm the plan shows `# ... will be moved to ...`, NOT `# ... will be destroyed`

The canonical example is `terraform/main.tf:421-424` — the metrics-bridge `moved` blocks added in PR #201.

## 2. Cloud Run service shape

For every `google_cloud_run_v2_service`:

- [ ] Probe paths use `/health`, NOT `/healthz`. Cloud Run v2 reserves `/healthz` at the frontend, so external `/healthz` returns a Google-branded 404
- [ ] Memory ≥ `512Mi` if `cpu_idle = false` (always-allocated CPU floor)
- [ ] `lifecycle.ignore_changes = [template[0].containers[0].image]` if image rollouts happen out-of-band via `gcloud run services update` (otherwise `terraform apply` reverts the image to the bootstrap default)
- [ ] Default/bootstrap `image` MUST respond to the configured probe path. `gcr.io/cloudrun/hello:latest` does NOT serve `/health` — using it as a default fails first-bootstrap because the service never becomes healthy
- [ ] `depends_on = [google_project_service.run]` so `run.googleapis.com` is enabled before service creation

## 3. Cloud Run revision suffix (`--revision-suffix`)

Cloud Run revision names follow RFC 1035: must start with a lowercase letter `[a-z]`, then `[a-z0-9-]{0,61}`, end with `[a-z0-9]`. They MUST also be unique per revision.

- [ ] Suffix MUST start with a lowercase letter. A raw 7-char git SHA starts with a hex digit ~62% of the time and fails the deploy. Prefix with a letter (e.g. `r-${GITHUB_SHA::7}-${GITHUB_RUN_ID}`)
- [ ] Suffix MUST be unique across runs. Deriving solely from the commit SHA collides on `workflow_dispatch` retry — append a per-run disambiguator (`$GITHUB_RUN_ID` in CI, `$(date +%s)` in scripts)

Current call sites to verify any new deploy path against:

- `.github/workflows/metrics-bridge.yml:107`
- `scripts/deploy-bridge.sh:103`

## 4. IAM ordering + dependencies

This bit me on PRs #197 and #200 — both P1 blockers.

- [ ] Project-level resources written by an impersonated SA MUST `depends_on` the binding that grants the org-terraform SA owner on the bootstrap project. Don't assume Terraform's implicit graph picks this up; the dependency is on a foreign-managed binding
- [ ] CI/CD deployer SAs need `roles/iam.serviceAccountTokenCreator` on the runtime SA they impersonate. Without it, Workload Identity Federation (`google-github-actions/auth`) fails at `getAccessToken` time before any Terraform/gcloud command runs
- [ ] Any new `google_project_iam_member` should be reviewed against the API enablement and SA bindings already present, not added as an isolated grant

## 5. Variable validation

For variables that gate critical behavior:

- [ ] Add a `validation` block for non-empty strings (image refs, project IDs, region). An empty string forwarded to a required field fails the apply with a cryptic error and blocks unrelated infra changes
- [ ] If a previous schema accepted an empty value as "disable this resource", normalize it back to a safe default (or fail loudly with a migration message) — silent breakage of previously-valid `terraform.tfvars` is a hostile change

## 6. Pre-apply rituals

- [ ] `pnpm infra:plan` ALWAYS before apply; read every `# ... will be destroyed` line
- [ ] If the plan touches `google_cloud_run_v2_service`, double-check that image drift is ignored and probe paths still match the deployed app
- [ ] After apply, hit the public URL once and confirm a 200 from `/health` — Cloud Run can return 503s for ~30s while the new revision rolls

## 7. Lessons already paid for

- PR #199 — `/healthz` returned a Google-branded 404 because Cloud Run v2 reserves the path; moved bridge health to `/health`
- PR #197 — bootstrap IAM only gated API enablement, not the project-level grants the impersonated SA needed
- PR #198 — Cloud Run rejected `256Mi` because `cpu_idle = false` requires `≥512Mi`
- PR #200 — Workload Identity Federation deploy failed at `getAccessToken` because deployer SA lacked `roles/iam.serviceAccountTokenCreator` on the runtime SA
- PR #201 — removing `count` without `moved` blocks would have planned destroy on a `deletion_protection = true` service; default `gcr.io/cloudrun/hello:latest` would have failed `/health` probes; revision suffixes derived from raw SHA can start with a digit and fail the deploy
