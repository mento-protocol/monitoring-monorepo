module "governance_watchdog" {
  activate_apis = [
    "cloudbuild.googleapis.com",
    "cloudfunctions.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "cloudscheduler.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "storage-api.googleapis.com",
  ]
  billing_account         = var.billing_account
  create_project_sa       = true
  default_service_account = "disable"
  name                    = var.project_name
  org_id                  = var.org_id
  random_project_id       = true
  source                  = "git::https://github.com/terraform-google-modules/terraform-google-project-factory.git?ref=9ac04a6868cadea19a5c016d4d0a4ae35d378b05" # commit hash of v15.0.1
}

output "project_id" {
  value = module.governance_watchdog.project_id
}
