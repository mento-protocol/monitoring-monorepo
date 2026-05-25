terraform {
  # replace_triggered_by requires Terraform >= 1.2.0
  required_version = ">= 1.2.0"
  required_providers {
    restapi = {
      source                = "mastercard/restapi"
      version               = ">= 2.0.1"
      configuration_aliases = [restapi.quicknode]
    }
    null = {
      source  = "hashicorp/null"
      version = ">= 3.2"
    }
  }
}

