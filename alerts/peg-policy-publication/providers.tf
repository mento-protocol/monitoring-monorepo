provider "google" {
  project                     = "mento-monitoring"
  impersonate_service_account = var.terraform_service_account
}
