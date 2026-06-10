# Cloud Functions auto-creates this Docker repo for function build images and
# never cleans it up — it had accumulated 64 images (~1.9 GB) by 2026-06-10.
# The import block adopts the existing repo into state on the next apply
# (idempotent afterwards) so the cleanup policies below can manage retention.
import {
  to = google_artifact_registry_repository.gcf_artifacts
  id = "projects/governance-watchdog-b2a6/locations/europe-west1/repositories/gcf-artifacts"
}

resource "google_artifact_registry_repository" "gcf_artifacts" {
  #checkov:skip=CKV_GCP_84:Repo is auto-created and managed by Cloud Functions with Google-managed encryption; imported as-is purely to attach cleanup policies. Switching to CMEK would force recreation and break the managed deploy flow.
  project       = module.governance_watchdog.project_id
  location      = var.region
  repository_id = "gcf-artifacts"
  format        = "DOCKER"
  mode          = "STANDARD_REPOSITORY"
  description   = "This repository is created and used by Cloud Functions for storing function docker images."

  labels = {
    goog-managed-by = "cloudfunctions"
  }

  # Retention: delete build images older than 30 days, but always keep the 3
  # most recent versions of each package (function image + its build cache),
  # so the serving image and rollback candidates are never collected. Policies
  # apply retroactively to the existing backlog.
  cleanup_policy_dry_run = false

  cleanup_policies {
    id     = "delete-older-than-30d"
    action = "DELETE"
    condition {
      older_than = "2592000s" # 30 days
    }
  }

  cleanup_policies {
    id     = "keep-3-most-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 3
    }
  }
}
