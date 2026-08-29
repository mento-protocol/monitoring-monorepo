# Local agent GitHub App credential bootstrap
# ──────────────────────────────────────────
#
# A human creates and installs the GitHub App outside this repo-scoped stack.
# Terraform owns the private-key secret after that explicit bootstrap. Local
# agents send structured operations to an operator-approved host broker that
# impersonates this service account. The broker uses short-lived installation
# tokens internally and never returns the PEM, JWT, token, or human GitHub
# credential to agents. This is an OS isolation
# boundary. The existing org-terraform project Owner and the Environment-gated
# production-infra impersonation path can also read Secret Manager payloads.
# The App has no Administration permission or ruleset bypass.

resource "google_service_account" "local_agent_github_broker" {
  project      = google_project.monitoring.project_id
  account_id   = "local-agent-github-broker"
  display_name = "Local agent GitHub credential broker"
  description  = "Broker identity that reads the local-agent GitHub App key to mint non-bypass installation tokens outside agent processes."

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [
    google_project_iam_member.terraform_owner,
    google_project_service.iam,
  ]
}

resource "google_secret_manager_secret" "local_agent_github_app_private_key" {
  project   = google_project.monitoring.project_id
  secret_id = "local-agent-github-app-private-key"

  replication {
    auto {}
  }

  labels = {
    managed_by = "terraform"
    purpose    = "local-agent-github-app"
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.secretmanager]
}

# Activation is a separate approved platform apply after a human creates the
# App, installs it only on this repository, and supplies the generated key
# through a gitignored operator tfvars file. The initial browser download uses
# the runbook's transient intake, removal, and revoke-on-uncertain-custody
# procedure. The guarded wrapper makes one
# mode-0600 copy in its mode-0700 private plan directory, reuses it for the
# exact plan/apply, and removes the directory in `finally`. The write-only field
# keeps the PEM out of Terraform plan and state. The non-secret counter controls
# deliberate rotation. After Secret Manager provisioning, the trusted broker
# keeps the PEM, JWT, and installation token inside its fixed process and
# returns only normalized operation results.
resource "google_secret_manager_secret_version" "local_agent_github_app_private_key" {
  count = var.local_agent_github_app_credential_active ? 1 : 0

  secret                 = google_secret_manager_secret.local_agent_github_app_private_key.id
  secret_data_wo         = var.local_agent_github_app_private_key
  secret_data_wo_version = var.local_agent_github_app_private_key_rotation_counter
  deletion_policy        = "DISABLE"

  lifecycle {
    create_before_destroy = true

    precondition {
      condition = (
        var.local_agent_github_app_id > 0 &&
        var.local_agent_github_app_installation_id > 0 &&
        var.local_agent_github_app_private_key_rotation_counter > 0
      )
      error_message = "Active local agent GitHub App credentials require positive App and installation IDs plus a positive rotation counter. Terraform sends the ephemeral private key only to the write-only Secret Manager field."
    }
  }
}

resource "google_secret_manager_secret_iam_member" "local_agent_github_broker_accessor" {
  project   = google_project.monitoring.project_id
  secret_id = google_secret_manager_secret.local_agent_github_app_private_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.local_agent_github_broker.email}"
}

# Keep host-broker access explicit. Do not reuse gcp_dev_members: a deployment
# role does not imply authority to mint agent GitHub credentials. Reviewed
# source pins the one dedicated service-account principal. An empty string is
# the fail-closed bootstrap state.
locals {
  local_agent_github_broker_impersonator = local.human_merge_boundary_policy.local_agent_github_broker_impersonator
}

resource "google_service_account_iam_member" "local_agent_github_broker_impersonator" {
  for_each = toset(
    local.local_agent_github_broker_impersonator == "" ?
    [] : [local.local_agent_github_broker_impersonator]
  )

  service_account_id = google_service_account.local_agent_github_broker.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = each.value

  lifecycle {
    precondition {
      condition     = can(regex("^serviceAccount:[^@[:space:]]+@[^@[:space:]]+\\.iam\\.gserviceaccount\\.com$", each.value))
      error_message = "The reviewed local agent GitHub broker impersonator must be one explicit serviceAccount: IAM principal."
    }
  }
}
