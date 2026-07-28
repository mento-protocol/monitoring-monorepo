# ── Peg policy source foundation ─────────────────────────────────────────────
#
# ADR 0048 required the protected identity cutover, legacy-authority removal,
# run drain, and final IAM audit before this source could merge. Those
# prerequisites are complete. The policy plane lives in a dedicated project so
# monitoring-project service agents and routine deploy identities cannot inherit
# access. This stack creates no policy object and does not attach the runtime
# identity to Cloud Run; later reviewed changes own those activation steps.

resource "google_project" "peg_policy" {
  name                = "Mento Peg Policy"
  project_id          = var.gcp_peg_policy_project_id
  org_id              = var.gcp_org_id
  billing_account     = var.gcp_billing_account
  auto_create_network = false

  lifecycle {
    prevent_destroy = true
  }
}

# The protected org-Terraform identity must bootstrap the new project before it
# can enable APIs or manage storage. This owner grant is an intentional
# control-plane exception: it can change project and bucket IAM, so production
# apply protection and the effective-IAM audit remain part of the boundary.
# trunk-ignore(checkov/CKV_GCP_117): protected Terraform needs Owner to bootstrap the dedicated project's IAM and buckets.
# trunk-ignore(checkov/CKV_GCP_42): the bootstrap Owner is an intentional, production-gated control-plane exception.
# trunk-ignore(checkov/CKV_GCP_49): the exception is scoped to the dedicated project and protected Terraform identity.
resource "google_project_iam_member" "peg_policy_terraform_owner" {
  project = google_project.peg_policy.project_id
  role    = "roles/owner"
  member  = "serviceAccount:${var.terraform_service_account}"
}

# Record every project-level admin read and data read/write action before the
# dedicated project's APIs, buckets, and identities are created.
resource "google_project_iam_audit_config" "peg_policy" {
  project = google_project.peg_policy.project_id
  service = "allServices"

  audit_log_config {
    log_type = "ADMIN_READ"
  }

  audit_log_config {
    log_type = "DATA_READ"
  }

  audit_log_config {
    log_type = "DATA_WRITE"
  }

  depends_on = [google_project_iam_member.peg_policy_terraform_owner]
}

# Keep the isolated project narrow: the source foundation explicitly enables
# only Cloud Storage and IAM. Runtime compute stays in the monitoring project.
resource "google_project_service" "peg_policy_storage" {
  project                    = google_project.peg_policy.project_id
  service                    = "storage.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_audit_config.peg_policy]
}

resource "google_project_service" "peg_policy_iam" {
  project                    = google_project.peg_policy.project_id
  service                    = "iam.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_audit_config.peg_policy]
}

resource "google_storage_bucket" "peg_policy" {
  name                        = google_project.peg_policy.project_id
  project                     = google_project.peg_policy.project_id
  location                    = var.gcp_region
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  logging {
    log_bucket        = google_storage_bucket.peg_policy_access_logs.name
    log_object_prefix = "peg-policy/"
  }

  # Cloud Storage deletes generations only after they have stayed noncurrent
  # for 30 days. This retention rule does not stop the publisher's objectAdmin
  # authority from deleting an object directly.
  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      days_since_noncurrent_time = 30
      with_state                 = "ARCHIVED"
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [
    google_project_service.peg_policy_storage,
    google_storage_bucket_iam_policy.peg_policy_access_logs,
  ]
}

# trunk-ignore(checkov/CKV_GCP_62): a bucket cannot write access logs to itself.
resource "google_storage_bucket" "peg_policy_access_logs" {
  name                        = "${google_project.peg_policy.project_id}-access-logs"
  project                     = google_project.peg_policy.project_id
  location                    = var.gcp_region
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age        = 90
      with_state = "LIVE"
    }
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      days_since_noncurrent_time = 30
      with_state                 = "ARCHIVED"
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.peg_policy_storage]
}

resource "google_project_iam_custom_role" "peg_policy_bucket_controller" {
  project     = google_project.peg_policy.project_id
  role_id     = "pegPolicyBucketController"
  title       = "Peg policy bucket controller"
  description = "Protected Terraform control of Peg bucket metadata, configuration, and authoritative IAM."
  permissions = [
    "storage.buckets.get",
    "storage.buckets.getIamPolicy",
    "storage.buckets.setIamPolicy",
    "storage.buckets.update",
  ]

  depends_on = [google_project_service.peg_policy_iam]
}

data "google_iam_policy" "peg_policy_access_logs" {
  binding {
    role = google_project_iam_custom_role.peg_policy_bucket_controller.name
    members = [
      "serviceAccount:${var.terraform_service_account}",
    ]
  }

  binding {
    role = "roles/storage.objectCreator"
    members = [
      "group:cloud-storage-analytics@google.com",
    ]
  }
}

resource "google_storage_bucket_iam_policy" "peg_policy_access_logs" {
  bucket      = google_storage_bucket.peg_policy_access_logs.name
  policy_data = data.google_iam_policy.peg_policy_access_logs.policy_data

  lifecycle {
    prevent_destroy = true
  }
}

# These service accounts intentionally have no keys and no project-level roles.
# Their sole access is the bucket-scoped grant below.
resource "google_service_account" "metrics_bridge_runtime" {
  project      = google_project.monitoring.project_id
  account_id   = "metrics-bridge-runtime"
  display_name = "Metrics Bridge runtime"
  description  = "Dormant runtime identity for private Peg policy reads."

  depends_on = [google_project_service.iam]
}

resource "google_service_account" "peg_policy_publisher" {
  project      = google_project.peg_policy.project_id
  account_id   = "peg-policy-publisher"
  display_name = "Peg policy publisher"
  description  = "Protected Terraform publisher for private Peg policy generations."

  depends_on = [google_project_service.peg_policy_iam]
}

data "google_iam_policy" "peg_policy" {
  binding {
    role = google_project_iam_custom_role.peg_policy_bucket_controller.name
    members = [
      "serviceAccount:${var.terraform_service_account}",
    ]
  }

  binding {
    role = "roles/storage.objectViewer"
    members = [
      "serviceAccount:${google_service_account.metrics_bridge_runtime.email}",
    ]
  }

  binding {
    role = "roles/storage.objectAdmin"
    members = [
      "serviceAccount:${google_service_account.peg_policy_publisher.email}",
    ]
  }
}

resource "google_storage_bucket_iam_policy" "peg_policy" {
  bucket      = google_storage_bucket.peg_policy.name
  policy_data = data.google_iam_policy.peg_policy.policy_data

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_storage_bucket_iam_policy.peg_policy_access_logs]
}

# Only the Environment-bound production applier can impersonate the publisher.
# PR plans, trusted-main refresh, routine deploy, and humans receive no route
# to read or write policy objects.
resource "google_service_account_iam_member" "production_infra_applier_peg_policy_publisher_token_creator" {
  service_account_id = google_service_account.peg_policy_publisher.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.production_infra_applier.email}"
}
