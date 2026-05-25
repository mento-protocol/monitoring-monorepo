terraform {
  required_version = ">= 1.10.0"
  required_providers {
    sentry = {
      source = "jianyuan/sentry"
      # 0.15.0-beta3 fixes the "Unable to create, got status 201" regression
      # in `sentry_issue_alert` with `actions_v2` — provider was treating HTTP
      # 201 Created as an error, orphaning the alert (created on Sentry's
      # side, missing from TF state). See provider issues #816, #844, #846.
      # Pinned with an explicit `<` upper bound so a future 0.16 doesn't
      # silently pull a major-bump (0.15.0 marks `sentry_issue_alert`
      # deprecated in favor of the new `sentry_alert` resource, which we'll
      # migrate to in a follow-up).
      version = "0.15.0-beta3"
    }
    discord = {
      source  = "Lucky3028/discord"
      version = ">= 2.0.1"
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
  }

  backend "gcs" {
    # https://console.cloud.google.com/storage/browser/mento-terraform-tfstate-6ed6
    bucket                      = "mento-terraform-tfstate-6ed6"
    prefix                      = "alerts" # Cannot use variables in backend config
    impersonate_service_account = "org-terraform@mento-terraform-seed-ffac.iam.gserviceaccount.com"
  }
}

