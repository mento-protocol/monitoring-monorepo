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
      version = ">= 6.11.0"
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
# Using individual resources so optional vars can use count without type-mixing.

resource "vercel_project_environment_variable" "hasura_url_multichain" {
  count      = var.hasura_url_multichain != "" ? 1 : 0
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "NEXT_PUBLIC_HASURA_URL_MULTICHAIN"
  value      = var.hasura_url_multichain
  target     = ["production", "preview"]
}

resource "vercel_project_environment_variable" "hasura_url_celo_sepolia" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "NEXT_PUBLIC_HASURA_URL_CELO_SEPOLIA"
  value      = var.hasura_url_celo_sepolia
  target     = ["production", "preview"]
}

resource "vercel_project_environment_variable" "hasura_url_monad_testnet" {
  count      = var.hasura_url_monad_testnet != "" ? 1 : 0
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "NEXT_PUBLIC_HASURA_URL_MONAD_TESTNET"
  value      = var.hasura_url_monad_testnet
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

resource "vercel_project_environment_variable" "auth_google_id" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "AUTH_GOOGLE_ID"
  value      = var.auth_google_id
  target     = ["production", "preview"]
  sensitive  = true
}

resource "vercel_project_environment_variable" "auth_google_secret" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "AUTH_GOOGLE_SECRET"
  value      = var.auth_google_secret
  target     = ["production", "preview"]
  sensitive  = true
}

resource "vercel_project_environment_variable" "auth_secret" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "AUTH_SECRET"
  value      = var.auth_secret
  target     = ["production", "preview"]
  sensitive  = true
}

resource "vercel_project_environment_variable" "cron_secret" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "CRON_SECRET"
  value      = var.cron_secret
  # Production-only: preview deployments do not run cron jobs and should not
  # have access to the backup trigger secret.
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

# ── GCP APIs ─────────────────────────────────────────────────────────────────

resource "google_project_service" "run" {
  project = google_project.monitoring.project_id
  service = "run.googleapis.com"
}

resource "google_project_service" "artifactregistry" {
  project = google_project.monitoring.project_id
  service = "artifactregistry.googleapis.com"
}

resource "google_project_service" "cloudbuild" {
  project = google_project.monitoring.project_id
  service = "cloudbuild.googleapis.com"
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

locals {
  # Content-addressed tag so Cloud Run rolls a new revision on each rebuild.
  metrics_bridge_image_tag = substr(sha256(join("", [
    filesha256("${path.module}/../metrics-bridge/Dockerfile"),
    sha256(join("", [for f in sort(fileset("${path.module}/../metrics-bridge/src", "**/*.ts")) : filesha256("${path.module}/../metrics-bridge/src/${f}")])),
    filesha256("${path.module}/../metrics-bridge/package.json"),
    filesha256("${path.module}/../metrics-bridge/tsconfig.json"),
    filesha256("${path.module}/../pnpm-lock.yaml"),
    filesha256("${path.module}/../pnpm-workspace.yaml"),
    filesha256("${path.module}/../cloudbuild.yaml"),
  ])), 0, 12)

  metrics_bridge_ar_repo = "${var.gcp_region}-docker.pkg.dev/${google_project.monitoring.project_id}/${google_artifact_registry_repository.metrics_bridge.repository_id}"
  metrics_bridge_image   = "${local.metrics_bridge_ar_repo}/metrics-bridge:${local.metrics_bridge_image_tag}"
}

# ── Image Build ──────────────────────────────────────────────────────────────
# Builds and pushes the metrics-bridge container image via Cloud Build.
# Triggers on source file content changes (content-addressed tag).

resource "null_resource" "metrics_bridge_build" {
  triggers = {
    image_tag = local.metrics_bridge_image_tag
  }

  provisioner "local-exec" {
    working_dir = "${path.module}/.."
    command     = <<-EOT
      gcloud builds submit \
        --project="${google_project.monitoring.project_id}" \
        --config=cloudbuild.yaml \
        --substitutions=_IMAGE="${local.metrics_bridge_image}" \
        --timeout=600s \
        .
    EOT
  }

  depends_on = [
    google_project_service.cloudbuild,
    google_artifact_registry_repository.metrics_bridge,
  ]
}

# ── Metrics Bridge (Cloud Run) ───────────────────────────────────────────────
# Polls Hasura for FPMM pool KPIs and exports Prometheus gauges.
# Scraped by Grafana Agent (Aegis repo) → Grafana Cloud alert rules.

resource "google_cloud_run_v2_service" "metrics_bridge" {
  project  = google_project.monitoring.project_id
  name     = "metrics-bridge"
  location = var.gcp_region

  depends_on = [
    google_project_service.run,
    null_resource.metrics_bridge_build,
  ]

  template {
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }
    containers {
      image = local.metrics_bridge_image
      ports {
        container_port = 8080
      }
      resources {
        limits = {
          memory = "256Mi"
          cpu    = "1"
        }
        # CPU must stay allocated between requests for the background polling loop.
        cpu_idle = false
      }
      env {
        name  = "HASURA_URL"
        value = var.hasura_url_multichain
      }
      env {
        name  = "POLL_INTERVAL_MS"
        value = "30000"
      }
    }
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

resource "google_project_iam_member" "dev_run_admin" {
  for_each = toset(var.gcp_dev_members)
  project  = google_project.monitoring.project_id
  role     = "roles/run.admin"
  member   = each.value
}

resource "google_project_iam_member" "dev_ar_writer" {
  for_each = toset(var.gcp_dev_members)
  project  = google_project.monitoring.project_id
  role     = "roles/artifactregistry.writer"
  member   = each.value
}

resource "google_project_iam_member" "dev_cloudbuild_editor" {
  for_each = toset(var.gcp_dev_members)
  project  = google_project.monitoring.project_id
  role     = "roles/cloudbuild.builds.editor"
  member   = each.value
}
