terraform {
  required_version = ">= 1.10.0"
  required_providers {
    discord = {
      source  = "Lucky3028/discord"
      version = ">= 2.0.1"
    }
    restapi = {
      source                = "mastercard/restapi"
      version               = ">= 2.0.1"
      configuration_aliases = [restapi.discord]
    }
  }
}

