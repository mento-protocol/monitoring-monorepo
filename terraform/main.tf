terraform {
  required_version = ">= 1.5"

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

  # No ignore_command — always build on every push.
  # A "smart skip" caused production to be silently stuck for weeks.

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

# Blob token is provisioned outside Terraform (no vercel_blob_store resource
# exists in the Vercel provider). Run `vercel blob create-store` once and add
# the resulting token to terraform.tfvars as `blob_read_write_token`.
resource "vercel_project_environment_variable" "blob_token" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "BLOB_READ_WRITE_TOKEN"
  value      = var.blob_read_write_token
  target     = ["production"]
  sensitive  = true
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
# Dedicated project for monitoring infrastructure, separate from mento-prod.
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

# ── Metrics Bridge (Cloud Run) ───────────────────────────────────────────────
# Polls Hasura for FPMM pool KPIs and exports Prometheus gauges.
# Scraped by Grafana Agent (Aegis repo) → Grafana Cloud alert rules.
#
# Image is managed out-of-band: `pnpm bridge:deploy` (or the CI workflow)
# runs `gcloud run services update metrics-bridge --image=<digest>` after
# Cloud Build pushes a new revision. Terraform owns the *shape* of the
# service (probes, env, scaling, memory) and ignores image drift via
# `lifecycle.ignore_changes` so running `pnpm infra:apply` never reverts
# the image back to the bootstrap placeholder.

resource "google_cloud_run_v2_service" "metrics_bridge" {
  project             = google_project.monitoring.project_id
  name                = "metrics-bridge"
  location            = var.gcp_region
  deletion_protection = true

  depends_on = [google_project_service.run]

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
    # terraform. Ignoring the attribute here means `pnpm infra:apply` won't
    # revert a freshly-deployed image back to the bootstrap placeholder.
    ignore_changes = [template[0].containers[0].image]
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
#   - cloudbuild.builds.editor → submit Cloud Build jobs
#   - artifactregistry.writer  → push images to AR
#   - run.admin                → update the Cloud Run service revision
#   - iam.serviceAccountUser   → "act-as" the runtime SA used by Cloud Run
locals {
  ci_deployer_roles = [
    "roles/cloudbuild.builds.editor",
    "roles/artifactregistry.writer",
    "roles/run.admin",
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

# The CI workflow runs `terraform apply -target=...`, so the deployer needs
# read/write on the Terraform state bucket (in a different project).
resource "google_storage_bucket_iam_member" "ci_deployer_tfstate" {
  bucket = "mento-terraform-tfstate-6ed6"
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.metrics_bridge_deployer.email}"
}

# The google provider in this module is configured with
# `impersonate_service_account = var.terraform_service_account`, so whenever
# the CI deployer runs `terraform apply` it mints an access token for
# `org-terraform@mento-terraform-seed-ffac`. That STS exchange requires
# `iam.serviceAccounts.getAccessToken`, which comes from tokenCreator on the
# target SA (not from project-level serviceAccountUser).
resource "google_service_account_iam_member" "ci_deployer_impersonate_org_terraform" {
  service_account_id = "projects/-/serviceAccounts/${var.terraform_service_account}"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.metrics_bridge_deployer.email}"
}
