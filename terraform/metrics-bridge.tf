# ── Artifact Registry ────────────────────────────────────────────────────────

resource "google_artifact_registry_repository" "metrics_bridge" {
  project       = google_project.monitoring.project_id
  location      = var.gcp_region
  repository_id = "metrics-bridge"
  format        = "DOCKER"
  description   = "Container images for the metrics-bridge service"

  depends_on = [google_project_service.artifactregistry]
}

# ── Metrics Bridge Cloud Build executor ──────────────────────────────────────
#
# The applied phase-one foundation gives Metrics Bridge a narrow executor in
# place of the project's Editor-bearing default Compute identity. Phase two
# pins `cloudbuild.yaml` to this identity; both deployment-path canaries passed.
# The follow-up cleanup removes default Compute's direct source-bucket Object
# Viewer. Its project-level Editor role remains a separate retirement task.
locals {
  metrics_bridge_builder_project_roles = toset([
    "roles/cloudbuild.builds.editor",
    "roles/logging.logWriter",
  ])
}

resource "google_service_account" "metrics_bridge_builder" {
  project      = google_project.monitoring.project_id
  account_id   = "metrics-bridge-builder"
  display_name = "Metrics Bridge Cloud Build executor"
  description  = "Dedicated least-privilege Cloud Build identity for Metrics Bridge image builds."

  depends_on = [
    google_project_iam_member.terraform_owner,
    google_project_service.iam,
  ]
}

# `cloudbuild.builds.editor` is the narrowest established project role used by
# this repository's user-specified Cloud Build executor. It permits Cloud Build
# lifecycle updates but does not grant Storage, Artifact Registry, Cloud Run,
# or runtime-identity authority. Logs and images stay separately scoped below.
resource "google_project_iam_member" "metrics_bridge_builder" {
  for_each = local.metrics_bridge_builder_project_roles

  project = google_project.monitoring.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.metrics_bridge_builder.email}"

  depends_on = [
    google_project_iam_member.terraform_owner,
    google_project_service.cloudbuild,
  ]
}

resource "google_artifact_registry_repository_iam_member" "metrics_bridge_builder_writer" {
  project    = google_artifact_registry_repository.metrics_bridge.project
  location   = google_artifact_registry_repository.metrics_bridge.location
  repository = google_artifact_registry_repository.metrics_bridge.repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.metrics_bridge_builder.email}"

  depends_on = [google_service_account.metrics_bridge_builder]
}

# ── Metrics Bridge (Cloud Run) ───────────────────────────────────────────────
# Polls Hasura for FPMM pool KPIs and exports Prometheus gauges.
# Scraped by Grafana Alloy (Aegis repo) → Grafana Cloud alert rules.
#
# Image rollouts are managed out-of-band: `pnpm bridge:deploy` (or the CI
# workflow) runs `gcloud run services update metrics-bridge --image=<digest>`
# after Cloud Build pushes a new revision. Terraform owns the service shape
# (probes, env, template scaling, memory) and ignores image plus Cloud Run
# deploy/API bookkeeping drift so running `pnpm infra:apply` never reverts a
# live revision back to the bootstrap placeholder or restarts the alerting
# pipeline for an unrelated platform change.

locals {
  # Contract-only lifecycle marker. A Terraform-owned template change sets this
  # to true and removes the revision ignore in the same reviewed rollout. After
  # apply and runtime proof, a separate stabilization change restores false and
  # the ignore so routine platform applies do not mint duplicate revisions.
  # Pause unrelated platform applies while this marker is true.
  metrics_bridge_template_rollout_active = true
}

resource "google_cloud_run_v2_service" "metrics_bridge" {
  project             = google_project.monitoring.project_id
  name                = "metrics-bridge"
  location            = var.gcp_region
  deletion_protection = true

  depends_on = [
    google_project_service.run,
    google_storage_bucket_iam_policy.peg_policy,
  ]

  # Keep the optional parent block present so the child ignore paths below can
  # preserve zero-valued defaults stamped by gcloud. `scaling_mode` stays
  # unignored and Terraform-managed.
  scaling {}

  template {
    # This identity has only the direct, bucket-scoped Object Viewer grant in
    # terraform/peg-policy.tf. It is intentionally attached even while the
    # policy pair is absent, so a later reviewed generation handoff needs no
    # unauthenticated or ad-hoc Cloud Run configuration.
    service_account = google_service_account.metrics_bridge_runtime.email

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
      # The paired policy configuration stays absent while the source-controlled
      # generation is null. Terraform derives both values from one reviewed
      # literal; it never accepts a caller-supplied policy URL or production
      # auth mode.
      dynamic "env" {
        for_each = local.peg_policy_runtime_env
        content {
          name  = env.key
          value = env.value
        }
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
    # Null is the intentional dormant state. Any non-null value must be the
    # positive signed-64-bit generation emitted by the protected publisher.
    # The generated URL below always carries that generation, so a mutable,
    # blank, or mismatched pair cannot reach a Cloud Run plan.
    precondition {
      condition     = local.peg_policy_runtime_generation == null ? true : (can(regex("^[1-9][0-9]*$", local.peg_policy_runtime_generation)) && can(tonumber(local.peg_policy_runtime_generation)) && tonumber(local.peg_policy_runtime_generation) <= 9223372036854775807)
      error_message = "peg_policy_runtime_generation must be null or a positive GCS generation within signed 64-bit range."
    }

    # The deploy path stamps the image, generated revision name, client
    # metadata, and service-level scaling defaults. In steady state the
    # generated name is ignored. Any Terraform-owned template rollout must set
    # metrics_bridge_template_rollout_active=true and remove only the revision
    # entry below; otherwise provider 6.50 can send the retained old name with
    # changed template content and Cloud Run rejects it with 409. Restore the
    # marker and ignore in a separate change after apply and runtime proof;
    # pause unrelated platform applies until that stabilization lands.
    # Per-revision template[0].scaling and service-level scaling_mode remain
    # managed in both phases.
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
      scaling[0].manual_instance_count,
      scaling[0].min_instance_count,
    ]
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
