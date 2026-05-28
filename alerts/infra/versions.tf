terraform {
  required_version = ">= 1.10.0"
  required_providers {
    sentry = {
      source = "jianyuan/sentry"
      # 0.15.0-beta3 supports both the new `sentry_alert` supertype resource
      # used by `channels/sentry-bridge/` AND the `sentry_project_issue_stream_monitor`
      # data source needed to feed it. The deprecated `sentry_issue_alert`
      # resource (which the bridge previously used) is no longer referenced
      # by any module here — see `channels/sentry-bridge/README.md` for the
      # migration rationale. Historical note: this beta also fixes the
      # "Unable to create, got status 201" regression that affected the old
      # `sentry_issue_alert` (provider issues #816, #844, #846).
      version = "0.15.0-beta3"
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
