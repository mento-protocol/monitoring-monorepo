# ── Artifact Registry ────────────────────────────────────────────────────────

resource "google_artifact_registry_repository" "metrics_bridge" {
  project       = google_project.monitoring.project_id
  location      = var.gcp_region
  repository_id = "metrics-bridge"
  format        = "DOCKER"
  description   = "Container images for the metrics-bridge service"

  depends_on = [google_project_service.artifactregistry]
}

# ── Metrics Bridge (Cloud Run) ───────────────────────────────────────────────
# Polls Hasura for FPMM pool KPIs and exports Prometheus gauges.
# Scraped by Grafana Alloy (Aegis repo) → Grafana Cloud alert rules.
#
# Image is managed out-of-band: `pnpm bridge:deploy` (or the CI workflow)
# runs `gcloud run services update metrics-bridge --image=<digest>` after
# Cloud Build pushes a new revision. Terraform owns the *shape* of the
# service (probes, env, scaling, memory) and ignores image drift via
# `lifecycle.ignore_changes` so running `pnpm infra:apply` never reverts
# the image back to the bootstrap placeholder.

resource "google_cloud_run_v2_service" "metrics_bridge" {
  project             = google_project.monitoring.project_id
  name                = "metrics-bridge"
  location            = var.gcp_region
  deletion_protection = true

  depends_on = [google_project_service.run]

  template {
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }
    containers {
      image = var.metrics_bridge_image
      ports {
        container_port = 8080
      }
      resources {
        # Cloud Run requires ≥512Mi when cpu_idle = false (always-allocated
        # CPU is unthrottled and won't run on smaller instances).
        limits = {
          memory = "512Mi"
          cpu    = "1"
        }
        # CPU must stay allocated between requests for the background polling loop.
        cpu_idle = false
      }
      env {
        name  = "HASURA_URL"
        value = var.hasura_url
      }
      env {
        name  = "POLL_INTERVAL_MS"
        value = "30000"
      }
      # Probes hit /health (NOT /healthz — Cloud Run v2 reserves /healthz at
      # the frontend, so exposing it externally returns a Google-branded 404).
      # Liveness restarts the container if /health returns 503 (stale poll).
      liveness_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 10
        period_seconds        = 30
        failure_threshold     = 3
      }
      startup_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 5
        failure_threshold     = 3
      }
    }
  }

  lifecycle {
    # Image rollouts are triggered by `gcloud run services update` from the
    # deploy path (scripts/deploy-bridge.sh and the GitHub workflow), not by
    # terraform. Ignoring the attribute here means `pnpm infra:apply` won't
    # revert a freshly-deployed image back to the bootstrap placeholder.
    ignore_changes = [template[0].containers[0].image]
  }
}

# Allow unauthenticated access so Grafana Alloy can scrape /metrics.
resource "google_cloud_run_v2_service_iam_member" "metrics_bridge_public" {
  project  = google_cloud_run_v2_service.metrics_bridge.project
  location = google_cloud_run_v2_service.metrics_bridge.location
  name     = google_cloud_run_v2_service.metrics_bridge.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# State migration: these resources used to be `count`-gated behind
# `var.metrics_bridge_image != ""`. Removing `count` changes the address from
# `[0]` → unindexed; the `moved` blocks make the rename explicit so a fresh
# state (DR, new env, co-maintainer pulling main without `terraform state mv`)
# reproduces the migration cleanly instead of planning destroy+recreate.
moved {
  from = google_cloud_run_v2_service.metrics_bridge[0]
  to   = google_cloud_run_v2_service.metrics_bridge
}

moved {
  from = google_cloud_run_v2_service_iam_member.metrics_bridge_public[0]
  to   = google_cloud_run_v2_service_iam_member.metrics_bridge_public
}
