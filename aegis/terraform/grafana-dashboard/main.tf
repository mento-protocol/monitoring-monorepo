terraform {
  required_version = ">= 1.9"

  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 4.36"
    }
  }
}

provider "grafana" {
  url  = "https://clabsmento.grafana.net"
  auth = var.grafana_service_account_token
}
