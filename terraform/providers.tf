terraform {
  # `>= 1.11` for write-only provider arguments and ephemeral variables used
  # by the Grafana Alloy Secret Manager versions. The root also uses the
  # `removed { lifecycle { destroy = false } }` block introduced in 1.7.
  required_version = ">= 1.11"

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
      version = "~> 6.50.0"
    }
    grafana = {
      source = "grafana/grafana"
      # Same constraint the other two Grafana-provider stacks declare
      # (`alerts/rules`, `aegis/terraform`), so a major-line bump is one
      # reviewed decision across all three. Each stack's lock file still pins
      # its own resolved 4.x patch.
      version = "~> 4.36"
    }
    github = {
      source = "integrations/github"
      # Keep the ruleset adoption boundary on the schema reviewed in ADR 0078.
      # Version 6.12.1 cannot represent the live core ruleset's unattributed-
      # change approval field. A provider update needs a separate review before
      # it can change that fail-closed adoption decision.
      version = "= 6.12.1"
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

# GitHub provider — used to manage repo-level GitHub Actions secrets,
# variables, repository settings, and the human-only main lifecycle ruleset on
# `monitoring-monorepo`.
# `var.github_token` should be a fine-grained PAT scoped to
# `mento-protocol/monitoring-monorepo` with Repository → Secrets: Read/write,
# Variables: Read/write, Administration: Read/write, and Environments:
# Read/write. Administration is required by `github_workflow_repository_permissions`
# in `github-actions-permissions.tf` (pins the default workflow-token permission
# to read-only — issue #1557) and `github_repository_ruleset` in
# `github-main-lifecycle-ruleset.tf`; Environments is required by the `sentry-pipeline`
# GitHub Environment and its `github_actions_environment_secret` resources in
# `github-environment.tf` (issue #1289) — managing the environment and writing
# its secrets (environment public-key read + secret PUT) 403s without it.
# This keeps the credential repository-scoped and avoids the org-admin scope
# that an organization-level secret or variable would force.
provider "github" {
  owner    = "mento-protocol"
  base_url = "https://api.github.com/"
  token    = var.github_token
}

# Grafana provider — this stack does not manage alert rules, folders, or
# dashboards (those belong to `alerts/rules` and `aegis/terraform`). It uses the
# provider for exactly one thing: minting the read-only Grafana identity the
# dashboard needs, so that credential can be wired straight into the Vercel
# project this stack already owns. See `grafana-read-access.tf` and
# [ADR 0063](../docs/adr/0063-dashboard-grafana-history-read-access.md).
provider "grafana" {
  url  = var.grafana_url
  auth = var.grafana_provisioning_token
}
