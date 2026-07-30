# Cloud Functions auto-creates this Docker repo for the build images of every
# Gen2 function in this project (onchain-event-handler, oncall-announcer, and
# sentry-ingest-watcher) and never cleans it up. Live inspection on 2026-07-30
# found it created 2025-11-17 with `cleanup_policies = []`, so every redeploy
# since has grown it. Same shape and same thresholds as
# governance-watchdog/infra/artifact-registry.tf, which solved this first; the
# two projects agreeing is worth more than a better-tuned number here.
#
# ADOPTION REQUIRES A ONE-TIME IMPORT. The repository already exists and Cloud
# Functions manages it, so a bare apply would fail on "already exists". The
# identity contract forbids top-level `import` blocks
# (SUPPORTED_TOP_LEVEL_KINDS in scripts/production-infra-identity-contract/
# surfaces.mjs), so run the state import explicitly before the adopting apply:
#
#   terraform -chdir=alerts/infra import \
#     google_artifact_registry_repository.gcf_artifacts \
#     projects/alerts-57ed/locations/europe-west1/repositories/gcf-artifacts
#
# Every attribute below was read off the live repository, so the post-import
# plan must show an in-place update that only adds the two cleanup policies.
# If it ever shows a replace, stop: that would delete live build images.
resource "google_artifact_registry_repository" "gcf_artifacts" {
  #checkov:skip=CKV_GCP_84:Repo is auto-created and managed by Cloud Functions with Google-managed encryption; imported as-is purely to attach cleanup policies. Switching to CMEK would force recreation and break the managed deploy flow.
  project       = local.project_id
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
