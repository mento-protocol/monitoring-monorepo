terraform {
  required_version = ">= 1.8"

  required_providers {
    restapi = {
      source  = "Mastercard/restapi"
      version = "~> 2.0.1"
    }
    google = {
      source  = "hashicorp/google"
      version = ">= 5.44.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.6.0"
    }
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }

  backend "gcs" {
    bucket                      = "mento-terraform-tfstate-6ed6"
    prefix                      = "governance-watchdog"
    impersonate_service_account = "org-terraform@mento-terraform-seed-ffac.iam.gserviceaccount.com"
  }
}

provider "google" {
  impersonate_service_account = var.terraform_service_account
}

# GitHub provider — used solely to mirror this stack's TF_VAR_* tfvars to
# repo Actions secrets consumed by .github/workflows/terraform-drift.yml
# (see github-secrets.tf). PAT: fine-grained, scoped to monitoring-monorepo,
# Secrets: Read and write only — same PAT as alerts/infra's github_token.
provider "github" {
  token = var.github_token
  owner = "mento-protocol"
}

# Configure the REST API provider for QuickNode.
# timeout gives the origin time to respond; QuickNode is behind Cloudflare, and 522 (connection timed out)
# can occur transiently — retry terraform apply if you see it.
#
# rate_limit: QuickNode returns 429 if several webhook API calls land in the same second. Each
# restapi_object refresh does Exists + Read (2 calls); two webhooks => 4 calls. Without throttling,
# Terraform fires them back-to-back and the 4th request often hits RateLimitError. Client-side RPS
# limiting spaces requests so plan/apply stays under their cap (see TF_LOG around restapi refresh).
provider "restapi" {
  uri                  = "https://api.quicknode.com"
  write_returns_object = true
  timeout              = 90
  rate_limit           = 1

  headers = {
    "Content-Type" = "application/json"
    "x-api-key"    = var.quicknode_api_key
  }
}
