module "governance_watchdog" {
  activate_apis = [
    # Gen2 function builds publish their images through Artifact Registry; without
    # this a from-scratch apply on a fresh project fails before the function exists.
    "artifactregistry.googleapis.com",
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

# Allow the dedicated trusted-main refresh identity to read live resource
# metadata without inheriting the write-capable `org-terraform` permissions or
# the basic Viewer role's Cloud Storage object-read convenience grant. The
# identity itself is created by the platform stack.
locals {
  terraform_refresh_readonly_project_roles = toset([
    "roles/artifactregistry.viewer",
    "roles/browser",
    "roles/cloudfunctions.viewer",
    "roles/cloudscheduler.viewer",
    "roles/iam.securityReviewer",
    "roles/iam.serviceAccountViewer",
    "roles/logging.viewer",
    "roles/monitoring.viewer",
    "roles/run.viewer",
    "roles/secretmanager.viewer",
    "roles/serviceusage.serviceUsageConsumer",
    "roles/serviceusage.serviceUsageViewer",
    "roles/storage.bucketViewer",
  ])
}

resource "google_project_iam_member" "terraform_refresh_readonly" {
  for_each = local.terraform_refresh_readonly_project_roles

  project = module.governance_watchdog.project_id
  role    = each.value
  member  = "serviceAccount:org-terraform-refresh-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com"

  depends_on = [module.governance_watchdog]
}

output "project_id" {
  value = module.governance_watchdog.project_id
}
