terraform {
  required_version = ">= 1.10.0"
  required_providers {
    sentry = {
      source  = "jianyuan/sentry"
      version = ">= 0.14.5"
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

