# ── Peg policy source foundation ─────────────────────────────────────────────
#
# ADR 0054 keeps the policy artifact in the monitoring project. This stack
# creates no policy object and does not attach the runtime identity to Cloud
# Run; later reviewed changes own those activation steps.

resource "google_storage_bucket" "peg_policy" {
  name                        = "${google_project.monitoring.project_id}-peg-policy"
  project                     = google_project.monitoring.project_id
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
    google_project_service.storage,
    google_storage_bucket_iam_policy.peg_policy_access_logs,
  ]
}

# trunk-ignore(checkov/CKV_GCP_62): a bucket cannot write access logs to itself.
resource "google_storage_bucket" "peg_policy_access_logs" {
  name                        = "${google_project.monitoring.project_id}-peg-policy-access-logs"
  project                     = google_project.monitoring.project_id
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

  depends_on = [google_project_service.storage]
}

data "google_iam_policy" "peg_policy_access_logs" {
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
# Their direct object permissions are the bucket-scoped grants below.
resource "google_service_account" "metrics_bridge_runtime" {
  project      = google_project.monitoring.project_id
  account_id   = "metrics-bridge-runtime"
  display_name = "Metrics Bridge runtime"
  description  = "Dormant runtime identity for private Peg policy reads."

  depends_on = [google_project_service.iam]
}

resource "google_service_account" "peg_policy_publisher" {
  project      = google_project.monitoring.project_id
  account_id   = "peg-policy-publisher"
  display_name = "Peg policy publisher"
  description  = "Protected Terraform publisher for private Peg policy generations."

  depends_on = [google_project_service.iam]
}

data "google_iam_policy" "peg_policy" {
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

# The Environment-bound production applier is the only direct Token Creator
# binding for the publisher. Effective project and inherited IAM remains subject
# to the required pre-apply and pre-activation audit.
resource "google_service_account_iam_member" "production_infra_applier_peg_policy_publisher_token_creator" {
  service_account_id = google_service_account.peg_policy_publisher.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.production_infra_applier.email}"
}
