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
    github = {
      source  = "integrations/github"
      version = "~> 6.6"
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

# GitHub provider — used solely to mirror Vercel-managed secrets (e.g.
# `VERCEL_AUTOMATION_BYPASS_SECRET`) into GitHub Actions org secrets so CI
# workflows can read them. `var.github_token` must be an org-admin PAT
# scoped to `admin:org` (or fine-grained with `Organization secrets:
# Read/write`) so `github_actions_organization_secret` can manage org-level
# secrets. Repo-level Actions secrets live in `alerts/infra/` instead and
# use a separate, narrower token.
provider "github" {
  owner = var.github_owner
  token = var.github_token
}
