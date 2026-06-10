# Allows cloud build to do builds and write build logs.
resource "google_project_iam_member" "cloudbuild_builder" {
  project = module.governance_watchdog.project_id
  role    = "roles/cloudbuild.builds.builder"
  # checkov:skip=CKV_GCP_49:The cloudbuild builder role should be safe to assign
  # See https://docs.prismacloud.io/en/enterprise-edition/policy-reference/google-cloud-policies/google-cloud-iam-policies/bc-gcp-iam-10
  member = "serviceAccount:${module.governance_watchdog.service_account_email}"
}

# Allows cloud build to access the function source code in the storage bucket
resource "google_storage_bucket_iam_member" "cloud_build_storage_access" {
  bucket = google_storage_bucket.watchdog_notifications_function.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${module.governance_watchdog.service_account_email}"
}
