terraform {
  required_version = ">= 1.11.0"
  required_providers {
    sentry = {
      source = "jianyuan/sentry"
      # Keep the root and sentry-bridge constraints exact. Stable 0.15.4
      # supports the monitor-driven `sentry_alert` resources and normalizes
      # Slack channel-name comparisons by trimming a leading `#` (upstream
      # PR #897). See `channels/sentry-bridge/README.md`.
      version = "0.15.4"
    }
    github = {
      source  = "integrations/github"
      version = ">= 6.0"
    }
    restapi = {
      source  = "mastercard/restapi"
      version = ">= 2.0.1"
    }
    google = {
      source  = "hashicorp/google"
      version = ">= 7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4"
    }
    null = {
      source  = "hashicorp/null"
      version = ">= 3.2"
    }
    local = {
      source  = "hashicorp/local"
      version = ">= 2.5"
    }

    # Used by `ci-failures-channel.tf` to GET Slack `usergroups.list` and
    # `usergroups.users.list` at plan time, so the channel invite can
    # target the current @eng membership without hardcoding user IDs.
    http = {
      source  = "hashicorp/http"
      version = ">= 3.4"
    }
  }

  backend "gcs" {
    # https://console.cloud.google.com/storage/browser/mento-terraform-tfstate-6ed6
    bucket                      = "mento-terraform-tfstate-6ed6"
    prefix                      = "alerts-infra" # Cannot use variables in backend config
    impersonate_service_account = "org-terraform@mento-terraform-seed-ffac.iam.gserviceaccount.com"
  }
}
