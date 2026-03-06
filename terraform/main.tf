terraform {
  required_version = ">= 1.5"

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

  # Only rebuild when something in ui-dashboard/ actually changed.
  # NOTE: Vercel runs this command with CWD = root_directory (ui-dashboard/),
  # so we use "." rather than "ui-dashboard" to reference the current dir.
  ignore_command = "git diff HEAD^ HEAD --quiet -- ."

  git_repository = {
    type              = "github"
    repo              = "mento-protocol/monitoring-monorepo"
    production_branch = "main"
  }
}

# ── Environment Variables ─────────────────────────────────────────────────────
# Using individual resources so optional vars can use count without type-mixing.

resource "vercel_project_environment_variable" "hasura_url_sepolia" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "NEXT_PUBLIC_HASURA_URL_SEPOLIA_HOSTED"
  value      = var.hasura_url_sepolia_hosted
  target     = ["production", "preview"]
}

resource "vercel_project_environment_variable" "hasura_secret_sepolia" {
  count      = var.hasura_secret_sepolia_hosted != "" ? 1 : 0
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "NEXT_PUBLIC_HASURA_SECRET_SEPOLIA_HOSTED"
  value      = var.hasura_secret_sepolia_hosted
  target     = ["production", "preview"]
  sensitive  = true
}

resource "vercel_project_environment_variable" "hasura_url_mainnet" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "NEXT_PUBLIC_HASURA_URL_MAINNET_HOSTED"
  value      = var.hasura_url_mainnet_hosted
  target     = ["production", "preview"]
}

resource "vercel_project_environment_variable" "hasura_secret_mainnet" {
  count      = var.hasura_secret_mainnet_hosted != "" ? 1 : 0
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "NEXT_PUBLIC_HASURA_SECRET_MAINNET_HOSTED"
  value      = var.hasura_secret_mainnet_hosted
  target     = ["production", "preview"]
  sensitive  = true
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
  count      = var.blob_read_write_token != "" ? 1 : 0
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "BLOB_READ_WRITE_TOKEN"
  value      = var.blob_read_write_token
  target     = ["production", "preview"]
  sensitive  = true
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
