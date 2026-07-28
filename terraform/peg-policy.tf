# ── Peg policy source foundation and dormant runtime handoff ──────────────────
#
# ADR 0054 keeps the policy artifact in the monitoring project. Policy
# publication remains a separate protected action. The committed generation
# below is deliberately null until that action reports a real GCS generation;
# changing it is the separately reviewed runtime-attachment handoff.

locals {
  # Do not replace this with a variable, a mutable object URL, or a placeholder.
  # After protected publication, set this source-controlled literal to the
  # positive peg_policy_generation output and review the resulting platform
  # plan. Null keeps both PEG_POLICY_* values absent and the peg loop dormant.
  peg_policy_runtime_generation = null

  peg_policy_runtime_url = local.peg_policy_runtime_generation == null ? null : "https://storage.googleapis.com/download/storage/v1/b/${google_storage_bucket.peg_policy.name}/o/peg-policy%2Fcurrent.json?alt=media&generation=${local.peg_policy_runtime_generation}"

  # One map owns both raw values. A generation therefore attaches the exact URL
  # and metadata mode together; no external input can select a different host,
  # object, auth mode, or mutable URL.
  peg_policy_runtime_env = local.peg_policy_runtime_generation == null ? {} : {
    PEG_POLICY_URL       = local.peg_policy_runtime_url
    PEG_POLICY_AUTH_MODE = "gcp-metadata"
  }
}

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
