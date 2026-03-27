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
  count      = var.hasura_url_multichain_hosted != "" ? 1 : 0
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "NEXT_PUBLIC_HASURA_URL_MULTICHAIN_HOSTED"
  value      = var.hasura_url_multichain_hosted
  target     = ["production", "preview"]
}

resource "vercel_project_environment_variable" "hasura_url_celo_sepolia" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "NEXT_PUBLIC_HASURA_URL_CELO_SEPOLIA_HOSTED"
  value      = var.hasura_url_celo_sepolia_hosted
  target     = ["production", "preview"]
}

resource "vercel_project_environment_variable" "hasura_url_celo_mainnet" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "NEXT_PUBLIC_HASURA_URL_CELO_MAINNET_HOSTED"
  value      = var.hasura_url_celo_mainnet_hosted
  target     = ["production", "preview"]
}

resource "vercel_project_environment_variable" "hasura_url_monad_mainnet" {
  count      = var.hasura_url_monad_mainnet_hosted != "" ? 1 : 0
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "NEXT_PUBLIC_HASURA_URL_MONAD_MAINNET_HOSTED"
  value      = var.hasura_url_monad_mainnet_hosted
  target     = ["production", "preview"]
}

resource "vercel_project_environment_variable" "hasura_url_monad_testnet" {
  count      = var.hasura_url_monad_testnet_hosted != "" ? 1 : 0
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "NEXT_PUBLIC_HASURA_URL_MONAD_TESTNET_HOSTED"
  value      = var.hasura_url_monad_testnet_hosted
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
