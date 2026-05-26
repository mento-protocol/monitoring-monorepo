terraform {
  required_version = ">= 1.10.0"
  required_providers {
    restapi = {
      source                = "mastercard/restapi"
      version               = ">= 2.0.1"
      configuration_aliases = [restapi.slack]
    }
  }
}
