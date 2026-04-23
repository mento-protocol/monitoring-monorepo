terraform {
  required_version = ">= 1.5"

  backend "gcs" {
    bucket = "mento-terraform-tfstate-6ed6"
    prefix = "monitoring-monorepo-alerts"
  }

  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3.7.0"
    }
  }
}
