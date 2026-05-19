# ── Read-only AI agent investigator ──────────────────────────────────────────
# Brings the manually configured gcloud MCP/Claude/Codex agent identity under
# IaC. The service account `agent-readonly@mento-monitoring.iam.gserviceaccount.com`
# is impersonated by trusted humans (via `gcloud --impersonate-service-account`
# or short-lived access tokens) to give Claude/Codex/MCP a read-only view of
# the Mento Labs GCP org — listing projects, inspecting Cloud Run, reading
# Cloud Asset metadata, etc. — without ever issuing keys.
#
# Least privilege:
#   - Project-scoped SA, hosted in `mento-monitoring` (not in any production
#     workload project).
#   - No keys provisioned (`google_service_account_key` deliberately absent);
#     access is exclusively via Token Creator impersonation of an authenticated
#     human identity.
#   - Org-level roles are strictly read-only (browser/viewer/cloudasset.viewer)
#     plus `serviceusage.serviceUsageConsumer` so the agent can call APIs it
#     can already see metadata for — required for tools like
#     `gcloud asset search-all-resources` that issue requests against
#     enabled-API endpoints.

# Allow-list of users permitted to mint short-lived tokens for the read-only
# agent SA. Kept as a list so additional investigators (incident responders,
# auditors) can be added without restructuring resources.
variable "agent_readonly_impersonators" {
  description = <<-EOT
    IAM members granted roles/iam.serviceAccountTokenCreator on the
    `agent-readonly` SA. These principals can impersonate the SA via
    `gcloud --impersonate-service-account` to drive read-only AI agent
    investigations (MCP, Claude Code, Codex). Format: `user:...`, `group:...`,
    or `serviceAccount:...`.
  EOT
  type        = list(string)
  default     = ["user:philip.paetz@mentolabs.xyz"]
}

# ── Required APIs ────────────────────────────────────────────────────────────
# `iamcredentials.googleapis.com` is already enabled in main.tf (needed for
# WIF). The remaining three are required for the agent's read paths and for
# Terraform itself to manage the project (resource manager) on cold bootstrap.

resource "google_project_service" "serviceusage" {
  project                    = google_project.monitoring.project_id
  service                    = "serviceusage.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_service" "cloudresourcemanager" {
  project                    = google_project.monitoring.project_id
  service                    = "cloudresourcemanager.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_service" "cloudasset" {
  project                    = google_project.monitoring.project_id
  service                    = "cloudasset.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project_iam_member.terraform_owner]
}

# ── Service Account ──────────────────────────────────────────────────────────

resource "google_service_account" "agent_readonly" {
  project      = google_project.monitoring.project_id
  account_id   = "agent-readonly"
  display_name = "Read-only AI agent investigator"
  description  = "Impersonated by trusted humans to give Claude/Codex/MCP read-only visibility across the Mento Labs GCP org. No keys — access via Token Creator impersonation only."

  depends_on = [google_project_service.iam]
}

# Token Creator binding lives on the SA resource (not project-scoped) so the
# grant is naturally constrained to this one identity. Allows the listed
# impersonators to mint short-lived access tokens for the SA.
resource "google_service_account_iam_member" "agent_readonly_token_creators" {
  for_each           = toset(var.agent_readonly_impersonators)
  service_account_id = google_service_account.agent_readonly.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = each.value
}

# ── Org-level read-only roles ────────────────────────────────────────────────
# Strictly read-only by design — see role audit notes inline. Bound at the
# org so the agent can enumerate any project under `mentolabs.xyz` without
# per-project plumbing. The impersonating human's own org membership is the
# upstream gate; this SA cannot be reached without first authenticating as
# one of the `agent_readonly_impersonators` listed above.
locals {
  agent_readonly_org_roles = [
    # Lists projects and basic metadata across the org (browse-only).
    "roles/browser",
    # Read-only on most resources (`*.get`, `*.list`) across enabled APIs.
    # Does not grant any mutation rights.
    "roles/viewer",
    # Read access to Cloud Asset Inventory exports + search-all-resources.
    "roles/cloudasset.viewer",
    # Required for the SA to *call* enabled-API endpoints it can see; without
    # it, `gcloud asset search-all-resources` and similar return PERMISSION_DENIED
    # at the service-usage check even though the resource-level role is granted.
    "roles/serviceusage.serviceUsageConsumer",
  ]
}

resource "google_organization_iam_member" "agent_readonly_org_roles" {
  for_each = toset(local.agent_readonly_org_roles)
  org_id   = var.gcp_org_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.agent_readonly.email}"
}
