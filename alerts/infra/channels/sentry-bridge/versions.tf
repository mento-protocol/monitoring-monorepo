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
  }
}

# Providers are passed from the root module
# This ensures the module uses the same provider configuration as the root

