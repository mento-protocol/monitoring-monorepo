terraform {
  # `>= 1.7` for the `removed { lifecycle { destroy = false } }` block used to
  # drop `vercel_project_environment_variable.blob_token` from state without
  # destroying the live env var.
  required_version = ">= 1.7"

  backend "gcs" {
    bucket = "mento-terraform-tfstate-6ed6"
    prefix = "monitoring-monorepo"
  }

  required_providers {
    vercel = {
      source  = "vercel/vercel"
      version = "~> 1.14"
    }
    upstash = {
      source  = "upstash/upstash"
      version = "~> 1.4"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
    google = {
      source  = "hashicorp/google"
      version = "~> 6.11"
    }
  }
}

# ── Providers ─────────────────────────────────────────────────────────────────

provider "vercel" {
  api_token = var.vercel_token
  team      = var.vercel_team_id
}

provider "upstash" {
  email   = var.upstash_email
  api_key = var.upstash_api_key
}

provider "google" {
  impersonate_service_account = var.terraform_service_account
  project                     = var.gcp_project_id
  region                      = var.gcp_region
}

# ── Upstash Redis ─────────────────────────────────────────────────────────────

resource "upstash_redis_database" "address_labels" {
  database_name  = "address-labels"
  region         = "global"
  primary_region = var.upstash_region
  tls            = true
}

locals {
  # The Upstash provider may return just a hostname slug or a full URL.
  # Normalise to a full HTTPS URL before embedding in env vars.
  redis_rest_url = startswith(
    upstash_redis_database.address_labels.endpoint, "https://"
  ) ? upstash_redis_database.address_labels.endpoint : "https://${upstash_redis_database.address_labels.endpoint}"
}

# ── Vercel Project ────────────────────────────────────────────────────────────

resource "vercel_project" "dashboard" {
  name      = "monitoring-dashboard"
  framework = "nextjs"
  team_id   = var.vercel_team_id

  # Deploy from monorepo root so pnpm-lock.yaml is included in the upload.
  # Next.js is detected from ui-dashboard/ via root_directory.
  root_directory  = "ui-dashboard"
  install_command = "pnpm install"
  build_command   = "pnpm build"

  # The path-aware build skip lives in ui-dashboard/vercel.json so it can be
  # tested and reviewed with app changes.

  git_repository = {
    type              = "github"
    repo              = "mento-protocol/monitoring-monorepo"
    production_branch = "main"
  }
}

# ── Environment Variables ─────────────────────────────────────────────────────

resource "vercel_project_environment_variable" "hasura_url" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "NEXT_PUBLIC_HASURA_URL"
  value      = var.hasura_url
  target     = ["production", "preview"]
}

resource "vercel_project_environment_variable" "redis_url" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "UPSTASH_REDIS_REST_URL"
  value      = local.redis_rest_url
  target     = ["production", "preview"]
}

resource "vercel_project_environment_variable" "redis_token" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "UPSTASH_REDIS_REST_TOKEN"
  value      = upstash_redis_database.address_labels.rest_token
  target     = ["production", "preview"]
  sensitive  = true
}

# `BLOB_READ_WRITE_TOKEN` was retired during the Vercel Blob OIDC cutover.
# Existing Terraform state referencing `vercel_project_environment_variable.blob_token`
# is cleared via this `removed` block. `destroy = false` keeps the state cleanup
# explicit and non-destructive if an older workspace still tracks the resource;
# the live dashboard project now gets `BLOB_STORE_ID` and
# `BLOB_WEBHOOK_PUBLIC_KEY` from the Vercel store integration instead.
removed {
  from = vercel_project_environment_variable.blob_token

  lifecycle {
    destroy = false
  }
}

# ── Auth Environment Variables ────────────────────────────────────────────
#
# SECURITY POSTURE — shared prod/preview AUTH_* values are intentional.
#
# The preview OAuth flow uses Auth.js's `redirectProxyUrl` (see auth.ts):
# Google callbacks land on the prod domain (the only whitelisted redirect URI
# in GCP), then proxy the session back to the preview origin. For that to
# work, `AUTH_SECRET` (which signs the state JWE and session JWTs) and
# the Google OAuth credentials MUST be identical on both targets — splitting
# them would break preview sign-in.
#
# Mitigating controls that make this acceptable:
#   1. Vercel Deployment Protection gates preview URLs to `mentolabs` team
#      SSO — only authorised team members can reach a preview in the first
#      place. (Verify in Vercel UI → Project Settings → Deployment Protection.)
#   2. Public PRs from forks are NOT deployed to preview by default for this
#      team (Vercel setting: Git → "Deploy for Fork Pull Requests" off).
#      If that setting is ever flipped on, these secrets become reachable to
#      untrusted contributors and MUST be rotated + scoped to production-only.
#   3. CRON_SECRET is explicitly scoped to production (see below).
#
# If the above controls are ever loosened, treat all three shared values as
# potentially exposed: rotate AUTH_GOOGLE_SECRET in GCP, regenerate AUTH_SECRET,
# then either (a) adopt a split-secret preview auth architecture (different
# OAuth client + domain-local state) or (b) drop preview app-auth entirely and
# rely on Vercel Deployment Protection alone (see commit 74e533f for the
# prior bypass pattern).
#
# Tracked: Codex finding 75f2920d (2026-04). Fix partial — CRON_SECRET has
# been scoped to production; AUTH_* sharing retained for the architectural
# reasons above.

resource "vercel_project_environment_variable" "auth_google_id" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "AUTH_GOOGLE_ID"
  value      = var.auth_google_id
  # Shared prod+preview: see security posture comment above.
  target    = ["production", "preview"]
  sensitive = true
}

resource "vercel_project_environment_variable" "auth_google_secret" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "AUTH_GOOGLE_SECRET"
  value      = var.auth_google_secret
  # Shared prod+preview: see security posture comment above.
  target    = ["production", "preview"]
  sensitive = true
}

resource "vercel_project_environment_variable" "auth_secret" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "AUTH_SECRET"
  value      = var.auth_secret
  # Shared prod+preview: AUTH_SECRET signs the state JWE verified by the
  # redirectProxyUrl handshake — must match on both targets. See above.
  target    = ["production", "preview"]
  sensitive = true
}

resource "vercel_project_environment_variable" "cron_secret" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "CRON_SECRET"
  value      = var.cron_secret
  # Production-only: preview deployments do not run cron jobs and should not
  # have access to the backup trigger secret. This prevents a compromised
  # preview build from forging Bearer auth against the prod /backup endpoint.
  target    = ["production"]
  sensitive = true
}

# Arkham Intelligence API key for the nightly enrichment cron. Production-only
# so a compromised preview build can't burn the rate-limit budget. `count`
# guard skips creation when the key isn't yet provisioned — the dashboard
# still deploys cleanly without it (the cron route returns 500 on missing key).
resource "vercel_project_environment_variable" "arkham_api_key" {
  count      = var.arkham_api_key == "" ? 0 : 1
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "ARKHAM_API_KEY"
  value      = var.arkham_api_key
  target     = ["production"]
  sensitive  = true
}

# Dune Analytics API key for the MiniPay sync cron (production-only, mirrors
# the Arkham guardrails — preview builds shouldn't burn Dune query credits).
resource "vercel_project_environment_variable" "dune_api_key" {
  count      = var.dune_api_key == "" ? 0 : 1
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "DUNE_API_KEY"
  value      = var.dune_api_key
  target     = ["production"]
  sensitive  = true
}

# Preview auth proxy — routes Google OAuth through the prod domain (already
# whitelisted in GCP), then forwards the session back to the preview URL.
resource "vercel_project_environment_variable" "auth_redirect_proxy_url" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "AUTH_REDIRECT_PROXY_URL"
  value      = "https://monitoring.mento.org/api/auth"
  # Must be set on BOTH production and preview — Auth.js only enables proxy
  # mode when this var is present in the stable (prod) env too.
  # See: https://authjs.dev/getting-started/deployment#securing-a-preview-deployment
  target = ["production", "preview"]
}

# Cron jobs are defined in ui-dashboard/vercel.json and activated automatically
# on first deploy. No Terraform resource is needed.

# ── Custom Domain ────────────────────────────────────────────────────────────
# DNS is already pointing to Vercel (CNAME → vercel-dns). Assigning the domain
# to this project is all that's needed.

resource "vercel_project_domain" "monitoring" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  domain     = "monitoring.mento.org"
}

# ── Local .vercel/project.json ────────────────────────────────────────────────
# Keeps the Vercel CLI linked to the correct project after creation/recreation.
# This file is gitignored but must exist locally for `vercel deploy` to work.

resource "local_file" "vercel_project_json" {
  content = jsonencode({
    projectId   = vercel_project.dashboard.id
    orgId       = var.vercel_team_id
    projectName = vercel_project.dashboard.name
  })
  filename        = "${path.module}/../.vercel/project.json"
  file_permission = "0644"
}

# ── GCP Project ──────────────────────────────────────────────────────────────
# Dedicated project for monitoring infrastructure.
# One `terraform apply` bootstraps everything: project → APIs → AR → image → Cloud Run.

resource "google_project" "monitoring" {
  name            = "Mento Monitoring"
  project_id      = var.gcp_project_id
  org_id          = var.gcp_org_id
  billing_account = var.gcp_billing_account

  lifecycle {
    prevent_destroy = true
  }
}

# Creator of the project does not automatically inherit owner rights on it,
# so grant the impersonated Terraform service account explicit ownership.
# Without this, every resource Terraform tries to create inside the project
# (Artifact Registry, Cloud Run, IAM bindings) fails with 403.
resource "google_project_iam_member" "terraform_owner" {
  project = google_project.monitoring.project_id
  role    = "roles/owner"
  member  = "serviceAccount:${var.terraform_service_account}"
}

# ── GCP APIs ─────────────────────────────────────────────────────────────────

resource "google_project_service" "run" {
  project                    = google_project.monitoring.project_id
  service                    = "run.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_service" "artifactregistry" {
  project                    = google_project.monitoring.project_id
  service                    = "artifactregistry.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_service" "cloudbuild" {
  project                    = google_project.monitoring.project_id
  service                    = "cloudbuild.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_service" "appengine" {
  project                    = google_project.monitoring.project_id
  service                    = "appengine.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_service" "appengineflex" {
  project                    = google_project.monitoring.project_id
  service                    = "appengineflex.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_service" "compute" {
  project                    = google_project.monitoring.project_id
  service                    = "compute.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_service" "secretmanager" {
  project                    = google_project.monitoring.project_id
  service                    = "secretmanager.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

# Needed for Workload Identity Federation (GitHub Actions OIDC → impersonation).
resource "google_project_service" "iam" {
  project                    = google_project.monitoring.project_id
  service                    = "iam.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_service" "iamcredentials" {
  project                    = google_project.monitoring.project_id
  service                    = "iamcredentials.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_service" "sts" {
  project                    = google_project.monitoring.project_id
  service                    = "sts.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

# ── Artifact Registry ────────────────────────────────────────────────────────

resource "google_artifact_registry_repository" "metrics_bridge" {
  project       = google_project.monitoring.project_id
  location      = var.gcp_region
  repository_id = "metrics-bridge"
  format        = "DOCKER"
  description   = "Container images for the metrics-bridge service"

  depends_on = [google_project_service.artifactregistry]
}

# ── Aegis App Engine ─────────────────────────────────────────────────────────
# App Engine applications are project-scoped and their location is immutable.
# `mento-monitoring` hosts both the Aegis default service and the grafana-agent
# service so monitoring runtime resources no longer live in `mento-prod`.

resource "google_app_engine_application" "aegis" {
  project     = google_project.monitoring.project_id
  location_id = var.aegis_app_engine_location_id

  depends_on = [google_project_service.appengine]

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  aegis_app_engine_default_service_account = "${google_project.monitoring.project_id}@appspot.gserviceaccount.com"

  grafana_agent_secret_ids = toset([
    "grafana-agent-endpoint",
    "grafana-agent-username",
    "grafana-agent-password",
  ])

  grafana_agent_cloudbuild_service_accounts = {
    legacy  = "${google_project.monitoring.number}@cloudbuild.gserviceaccount.com"
    compute = "${google_project.monitoring.number}-compute@developer.gserviceaccount.com"
  }

  grafana_agent_cloudbuild_project_roles = toset([
    "roles/appengine.appAdmin",
    "roles/artifactregistry.writer",
    "roles/cloudbuild.builds.editor",
    "roles/logging.viewer",
    "roles/storage.admin",
  ])
}

resource "google_secret_manager_secret" "grafana_agent" {
  for_each  = local.grafana_agent_secret_ids
  project   = google_project.monitoring.project_id
  secret_id = each.value

  replication {
    auto {}
  }

  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_iam_member" "grafana_agent_cloudbuild_accessor" {
  for_each  = google_secret_manager_secret.grafana_agent
  project   = google_project.monitoring.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_project.monitoring.number}@cloudbuild.gserviceaccount.com"

  depends_on = [google_project_service.cloudbuild]
}

resource "google_secret_manager_secret_iam_member" "grafana_agent_cloudbuild_compute_accessor" {
  for_each  = google_secret_manager_secret.grafana_agent
  project   = google_project.monitoring.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_project.monitoring.number}-compute@developer.gserviceaccount.com"

  depends_on = [
    google_project_service.appengineflex,
    google_project_service.compute,
  ]
}

# App Engine Flex apps run as the App Engine default SA
# (`<project>@appspot.gserviceaccount.com`), not the Compute Engine default
# SA. The metadata server in the application's request context returns the
# AppSpot SA's token, so `grafana-agent/entrypoint.sh` needs THIS binding —
# the Compute SA grant above is preserved for the legacy Cloud Build path
# and other consumers but isn't what authenticates the runtime fetch.
resource "google_secret_manager_secret_iam_member" "grafana_agent_appspot_accessor" {
  for_each  = google_secret_manager_secret.grafana_agent
  project   = google_project.monitoring.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.aegis_app_engine_default_service_account}"

  depends_on = [
    google_project_service.appengineflex,
    google_project_service.secretmanager,
  ]
}

resource "google_project_iam_member" "grafana_agent_cloudbuild_deployer" {
  for_each = {
    for binding in setproduct(keys(local.grafana_agent_cloudbuild_service_accounts), local.grafana_agent_cloudbuild_project_roles) :
    "${binding[0]}:${binding[1]}" => {
      member = "serviceAccount:${local.grafana_agent_cloudbuild_service_accounts[binding[0]]}"
      role   = binding[1]
    }
  }

  project = google_project.monitoring.project_id
  role    = each.value.role
  member  = each.value.member

  depends_on = [
    google_project_iam_member.terraform_owner,
    google_project_service.appengineflex,
    google_project_service.cloudbuild,
    google_project_service.compute,
  ]
}

resource "google_service_account_iam_member" "grafana_agent_cloudbuild_appengine_default_service_account_user" {
  for_each = local.grafana_agent_cloudbuild_service_accounts

  service_account_id = "projects/${google_project.monitoring.project_id}/serviceAccounts/${local.aegis_app_engine_default_service_account}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${each.value}"

  depends_on = [
    google_app_engine_application.aegis,
    google_project_iam_member.grafana_agent_cloudbuild_deployer,
  ]
}

# ── Metrics Bridge (Cloud Run) ───────────────────────────────────────────────
# Polls Hasura for FPMM pool KPIs and exports Prometheus gauges.
# Scraped by Grafana Agent (Aegis repo) → Grafana Cloud alert rules.
#
# Image is managed out-of-band: `pnpm bridge:deploy` (or the CI workflow)
# runs `gcloud run services update metrics-bridge --image=<digest>` after
# Cloud Build pushes a new revision. Terraform owns the *shape* of the
# service (probes, env, template scaling, memory) and ignores image plus the
# observed Cloud Run API bookkeeping drift via `lifecycle.ignore_changes` so
# running `pnpm infra:apply` never reverts the deployed revision or re-applies
# cosmetic deploy metadata.

resource "google_cloud_run_v2_service" "metrics_bridge" {
  project             = google_project.monitoring.project_id
  name                = "metrics-bridge"
  location            = var.gcp_region
  deletion_protection = true

  depends_on = [google_project_service.run]

  scaling {
    # Service-level mode stays managed; only API-filled zero count fields below
    # are ignored as bookkeeping drift.
    scaling_mode = "AUTOMATIC"
  }

  template {
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }
    containers {
      image = var.metrics_bridge_image
      ports {
        container_port = 8080
      }
      resources {
        # Cloud Run requires ≥512Mi when cpu_idle = false (always-allocated
        # CPU is unthrottled and won't run on smaller instances).
        limits = {
          memory = "512Mi"
          cpu    = "1"
        }
        # CPU must stay allocated between requests for the background polling loop.
        cpu_idle = false
      }
      env {
        name  = "HASURA_URL"
        value = var.hasura_url
      }
      env {
        name  = "POLL_INTERVAL_MS"
        value = "30000"
      }
      # Probes hit /health (NOT /healthz — Cloud Run v2 reserves /healthz at
      # the frontend, so exposing it externally returns a Google-branded 404).
      # Liveness restarts the container if /health returns 503 (stale poll).
      liveness_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 10
        period_seconds        = 30
        failure_threshold     = 3
      }
      startup_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 5
        failure_threshold     = 3
      }
    }
  }

  lifecycle {
    # Image rollouts are triggered by `gcloud run services update` from the
    # deploy path (scripts/deploy-bridge.sh and the GitHub workflow), not by
    # terraform. The Cloud Run API also rewrites bookkeeping fields on each
    # deployment. Ignoring those attributes keeps `pnpm infra:apply` focused on
    # intentional service-shape changes instead of cosmetic deploy drift.
    ignore_changes = [
      client,
      client_version,
      scaling[0].manual_instance_count,
      scaling[0].min_instance_count,
      template[0].containers[0].image,
      # Suppresses live revision-name drift from gcloud rollouts. Remove or
      # re-audit this ignore entry in any PR that intentionally changes the
      # Terraform-owned template shape so Cloud Run can mint a fresh revision.
      template[0].revision,
    ]
  }
}

# Allow unauthenticated access so Grafana Agent can scrape /metrics.
resource "google_cloud_run_v2_service_iam_member" "metrics_bridge_public" {
  project  = google_cloud_run_v2_service.metrics_bridge.project
  location = google_cloud_run_v2_service.metrics_bridge.location
  name     = google_cloud_run_v2_service.metrics_bridge.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# State migration: these resources used to be `count`-gated behind
# `var.metrics_bridge_image != ""`. Removing `count` changes the address from
# `[0]` → unindexed; the `moved` blocks make the rename explicit so a fresh
# state (DR, new env, co-maintainer pulling main without `terraform state mv`)
# reproduces the migration cleanly instead of planning destroy+recreate.
moved {
  from = google_cloud_run_v2_service.metrics_bridge[0]
  to   = google_cloud_run_v2_service.metrics_bridge
}

moved {
  from = google_cloud_run_v2_service_iam_member.metrics_bridge_public[0]
  to   = google_cloud_run_v2_service_iam_member.metrics_bridge_public
}

# ── Dev Team IAM ─────────────────────────────────────────────────────────────
# Gives devs the ability to deploy new revisions, push images, and submit builds.
# All depend on `terraform_owner` so the impersonated SA has project-level
# setIamPolicy rights before TF schedules these bindings on a cold bootstrap.

resource "google_project_iam_member" "dev_run_admin" {
  for_each = toset(var.gcp_dev_members)
  project  = google_project.monitoring.project_id
  role     = "roles/run.admin"
  member   = each.value

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_iam_member" "dev_ar_writer" {
  for_each = toset(var.gcp_dev_members)
  project  = google_project.monitoring.project_id
  role     = "roles/artifactregistry.writer"
  member   = each.value

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_iam_member" "dev_cloudbuild_editor" {
  for_each = toset(var.gcp_dev_members)
  project  = google_project.monitoring.project_id
  role     = "roles/cloudbuild.builds.editor"
  member   = each.value

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_iam_member" "dev_storage_admin" {
  for_each = toset(var.gcp_dev_members)
  project  = google_project.monitoring.project_id
  role     = "roles/storage.admin"
  member   = each.value

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_iam_member" "dev_appengine_admin" {
  for_each = toset(var.gcp_dev_members)
  project  = google_project.monitoring.project_id
  role     = "roles/appengine.appAdmin"
  member   = each.value

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_service_account_iam_member" "dev_appengine_default_service_account_user" {
  for_each = toset(var.gcp_dev_members)

  service_account_id = "projects/${google_project.monitoring.project_id}/serviceAccounts/${local.aegis_app_engine_default_service_account}"
  role               = "roles/iam.serviceAccountUser"
  member             = each.value

  depends_on = [
    google_app_engine_application.aegis,
    google_project_iam_member.dev_appengine_admin,
  ]
}

# cloudbuild.yaml pins `options.logging: CLOUD_LOGGING_ONLY` so both CI and
# `scripts/deploy-bridge.sh` stream logs from Cloud Logging (not the default
# GCS log bucket). Devs need `logging.viewer` to read those streams — without
# it, `pnpm bridge:deploy` runs the build but fails at log-stream time.
# Mirrors the same role on `ci_deployer_roles`.
resource "google_project_iam_member" "dev_logging_viewer" {
  for_each = toset(var.gcp_dev_members)
  project  = google_project.monitoring.project_id
  role     = "roles/logging.viewer"
  member   = each.value

  depends_on = [google_project_iam_member.terraform_owner]
}

# ── CI Deploy via Workload Identity Federation ───────────────────────────────
# GitHub Actions workflows from mento-protocol/monitoring-monorepo impersonate
# `metrics-bridge-deployer` via OIDC — no long-lived JSON keys required.
#
# After apply, set two GitHub repo secrets (run from repo root):
#   gh secret set GCP_WORKLOAD_IDENTITY_PROVIDER \
#     --body="$(terraform -chdir=terraform output -raw ci_wif_provider)"
#   gh secret set GCP_SERVICE_ACCOUNT \
#     --body="$(terraform -chdir=terraform output -raw ci_deployer_email)"

resource "google_iam_workload_identity_pool" "github_actions" {
  project                   = google_project.monitoring.project_id
  workload_identity_pool_id = "github-actions"
  display_name              = "GitHub Actions"
  description               = "Federation pool for mento-protocol GitHub Actions workflows"

  depends_on = [google_project_service.iam]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = google_project.monitoring.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github_actions.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub"

  # Attribute condition gates which OIDC tokens are accepted. Restrict to the
  # monitoring-monorepo repo so other mento-protocol repos can't use this pool
  # to impersonate our deployer SA.
  attribute_condition = "attribute.repository == \"mento-protocol/monitoring-monorepo\""

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "metrics_bridge_deployer" {
  project      = google_project.monitoring.project_id
  account_id   = "metrics-bridge-deployer"
  display_name = "metrics-bridge CI deployer"
  description  = "Impersonated by GitHub Actions via WIF to deploy the bridge"

  depends_on = [google_project_service.iam]
}

# Any workflow in the repo can impersonate the deployer SA. Tighten later by
# swapping principalSet → principal with a workflow-ref attribute mapping.
resource "google_service_account_iam_member" "deployer_wif_binding" {
  service_account_id = google_service_account.metrics_bridge_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_actions.name}/attribute.repository/mento-protocol/monitoring-monorepo"
}

# Project-level grants the CI SA needs for the full deploy flow:
#   - cloudbuild.builds.editor  → submit Cloud Build jobs
#   - storage.admin             → `gcloud builds submit` runs a project-wide
#                                 `storage.buckets.list` probe before upload
#                                 to resolve the default `<project>_cloudbuild`
#                                 staging bucket. storage.admin grants list +
#                                 object-write; scoping to one bucket doesn't
#                                 work because the probe is project-scoped.
#                                 Root cause of every failed bridge deploy
#                                 since PR #206 (misleading "bucket forbidden
#                                 / serviceusage.services.use" error —
#                                 PR #216 tried the CLI's suggested role, it
#                                 didn't work; this PR replaces it with the
#                                 permissions actually exercised by the CLI).
#                                 Broader than strictly needed — the CI SA
#                                 could manage any GCS bucket in the project.
#                                 Acceptable because `mento-monitoring` is a
#                                 single-tenant project (only metrics-bridge
#                                 lives here; Vercel + Upstash are off-project,
#                                 Artifact Registry is covered by
#                                 `artifactregistry.writer` separately).
#                                 Tighten to a custom role if this project
#                                 ever hosts sensitive GCS data.
#   - logging.viewer            → stream Cloud Build logs back to the runner
#                                 so `gcloud builds submit` blocks until the
#                                 build finishes (otherwise it exits with
#                                 "can only stream logs if you are Viewer").
#                                 Pair with `options.logging: CLOUD_LOGGING_ONLY`
#                                 in cloudbuild.yaml so logs land in Cloud
#                                 Logging (not the default GCS log bucket).
#   - artifactregistry.writer   → push images to AR
#   - run.admin                 → update the Cloud Run service revision
#   - iam.serviceAccountUser    → "act-as" the runtime SA used by Cloud Run
locals {
  ci_deployer_roles = [
    "roles/cloudbuild.builds.editor",
    "roles/storage.admin",
    "roles/logging.viewer",
    "roles/artifactregistry.writer",
    "roles/run.admin",
    "roles/appengine.appAdmin",
    "roles/iam.serviceAccountUser",
  ]
}

resource "google_project_iam_member" "ci_deployer" {
  for_each = toset(local.ci_deployer_roles)
  project  = google_project.monitoring.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.metrics_bridge_deployer.email}"

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_service_account_iam_member" "ci_appengine_default_service_account_user" {
  service_account_id = "projects/${google_project.monitoring.project_id}/serviceAccounts/${local.aegis_app_engine_default_service_account}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.metrics_bridge_deployer.email}"

  depends_on = [
    google_app_engine_application.aegis,
    google_project_iam_member.ci_deployer,
  ]
}

# Allows the CI deployer SA to mint short-lived tokens for `org-terraform`, the
# seed-project SA used by `alerts/infra/` for both its GCS backend
# (`impersonate_service_account` in `alerts/infra/versions.tf`) and its google
# provider (`alerts/infra/providers.tf`). Without this grant, the CI workflow
# `alerts-infra.yml` fails at `terraform init` with a 403 from STS — the
# deployer SA is authorized via WIF but can't impersonate `org-terraform`.
#
# The binding lives on `org-terraform` in the seed project, NOT in
# `mento-monitoring`. `google_service_account_iam_member` makes the target
# explicit (vs. a project-level binding) so the blast radius is one SA, not
# the whole seed project. `org-terraform` already has the rights it needs in
# the seed project to grant this binding on itself.
resource "google_service_account_iam_member" "ci_alerts_infra_org_terraform_token_creator" {
  # `service_account_id` must use the fully-qualified
  # `projects/<project>/serviceAccounts/<email>` form — the google provider
  # rejects the email-only form at apply-time with a regex validation
  # error, even though `terraform validate` passes both. The project
  # appearing twice (in the path AND embedded in the email) is unavoidable.
  service_account_id = "projects/mento-terraform-seed-ffac/serviceAccounts/${var.terraform_service_account}"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.metrics_bridge_deployer.email}"
}
