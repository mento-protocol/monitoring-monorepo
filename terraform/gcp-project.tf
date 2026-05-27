# ── GCP Project ──────────────────────────────────────────────────────────────
# Dedicated project for monitoring infrastructure.
# One `terraform apply` bootstraps everything: project → APIs → AR → image → Cloud Run.

resource "google_project" "monitoring" {
  name            = "Mento Monitoring"
  project_id      = var.gcp_project_id
  org_id          = var.gcp_org_id
  billing_account = var.gcp_billing_account

  lifecycle {
    prevent_destroy = true
  }
}

# Creator of the project does not automatically inherit owner rights on it,
# so grant the impersonated Terraform service account explicit ownership.
# Without this, every resource Terraform tries to create inside the project
# (Artifact Registry, Cloud Run, IAM bindings) fails with 403.
resource "google_project_iam_member" "terraform_owner" {
  project = google_project.monitoring.project_id
  role    = "roles/owner"
  member  = "serviceAccount:${var.terraform_service_account}"
}

# ── GCP APIs ─────────────────────────────────────────────────────────────────

resource "google_project_service" "run" {
  project                    = google_project.monitoring.project_id
  service                    = "run.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_service" "artifactregistry" {
  project                    = google_project.monitoring.project_id
  service                    = "artifactregistry.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_service" "cloudbuild" {
  project                    = google_project.monitoring.project_id
  service                    = "cloudbuild.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_service" "appengine" {
  project                    = google_project.monitoring.project_id
  service                    = "appengine.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_service" "appengineflex" {
  project                    = google_project.monitoring.project_id
  service                    = "appengineflex.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_service" "compute" {
  project                    = google_project.monitoring.project_id
  service                    = "compute.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_service" "secretmanager" {
  project                    = google_project.monitoring.project_id
  service                    = "secretmanager.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

# Needed for Workload Identity Federation (GitHub Actions OIDC → impersonation).
resource "google_project_service" "iam" {
  project                    = google_project.monitoring.project_id
  service                    = "iam.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_service" "iamcredentials" {
  project                    = google_project.monitoring.project_id
  service                    = "iamcredentials.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_service" "sts" {
  project                    = google_project.monitoring.project_id
  service                    = "sts.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}
