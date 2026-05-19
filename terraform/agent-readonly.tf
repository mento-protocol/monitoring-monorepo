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
#   - Org-level roles use *predefined* read-only roles only — no basic
#     `roles/viewer`/`roles/editor`/`roles/owner` (Checkov CKV_GCP_115). The
#     curated set below combines `browser` + `cloudasset.viewer` +
#     `iam.securityReviewer` for org-wide visibility, plus service-specific
#     viewer roles for the surfaces agents actually investigate (Cloud Run,
#     logging, monitoring, artifact registry, compute, storage). Cloud Asset
#     Inventory does most of the metadata lifting; the service viewer roles
#     are scoped to read-only verbs only.
#   - `serviceusage.serviceUsageConsumer` is required for the SA to *call*
#     enabled-API endpoints it can see — without it, `gcloud asset
#     search-all-resources` and similar return PERMISSION_DENIED at the
#     service-usage check.
#
# Bootstrap (one-time, for maintainers):
#   The SA + Token Creator grant + org-level bindings were originally created
#   by hand in the production `mento-monitoring` project. On the first apply
#   after this PR merges, adopt the existing live resources into Terraform
#   state with the documented `terraform import` commands at the bottom of
#   this file BEFORE running `terraform apply`. Once state contains them,
#   subsequent applies are no-ops for the adopted bindings and create paths
#   for any new bindings (e.g. additional impersonators, additional org roles)
#   proceed normally.
#
#   `import` blocks are deliberately NOT used: a `for_each` import block over
#   the desired binding set would attempt to import every member, including
#   members not yet present in the live policy, and fail with "Cannot import
#   non-existent remote object" before Terraform can create them. Manual
#   `terraform import` keeps the adoption path strictly opt-in and lets the
#   normal create path handle anything not already in the live policy.

# Allow-list of principals permitted to mint short-lived tokens for the
# read-only agent SA. Kept as a list so additional investigators (incident
# responders, auditors) can be added without restructuring resources.
variable "agent_readonly_impersonators" {
  description = <<-EOT
    IAM members granted roles/iam.serviceAccountTokenCreator on the
    `agent-readonly` SA. These principals can impersonate the SA via
    `gcloud --impersonate-service-account` to drive read-only AI agent
    investigations (MCP, Claude Code, Codex). Format: `user:...`, `group:...`,
    or `serviceAccount:...`. Defaults to the eng@mentolabs.xyz Google Group so
    any engineer inherits access without per-user IAM churn; override in
    `terraform.tfvars` to add incident responders or external auditors.
  EOT
  type        = list(string)
  default     = ["group:eng@mentolabs.xyz"]
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
#
# IMPORTANT: no basic roles (`roles/viewer`/`roles/editor`/`roles/owner`) are
# bound here — Checkov CKV_GCP_115 forbids basic roles at the org level. The
# union of the predefined roles below approximates `roles/viewer`'s read
# surface for the resource types an investigator actually touches, without
# the open-ended "*.get/*.list on every future API" blast radius of viewer.
locals {
  agent_readonly_org_roles = [
    # Browse the resource hierarchy: list folders, projects, basic metadata.
    "roles/browser",
    # Read Cloud Asset Inventory: `gcloud asset search-all-resources`,
    # `search-all-iam-policies`, export snapshots. Covers most resource
    # *metadata* without per-service viewer roles.
    "roles/cloudasset.viewer",
    # Read IAM policies + role definitions across the org (read-only).
    # Non-basic substitute for the IAM-introspection slice of `roles/viewer`.
    "roles/iam.securityReviewer",
    # Required for the SA to *call* enabled-API endpoints it can see; without
    # it, `gcloud asset search-all-resources` and similar return PERMISSION_DENIED
    # at the service-usage check even though the resource-level role is granted.
    "roles/serviceusage.serviceUsageConsumer",
    # Service-specific read-only roles. These are the surfaces investigators
    # actually inspect — keeping them explicit (vs. basic viewer) means a new
    # GCP API does not auto-grant the agent read access without review.
    "roles/run.viewer",               # Cloud Run services, revisions, traffic
    "roles/logging.viewer",           # Cloud Logging entries + log-based metrics
    "roles/monitoring.viewer",        # Cloud Monitoring dashboards + metrics
    "roles/artifactregistry.reader",  # Artifact Registry repos + images
    "roles/compute.viewer",           # Compute Engine read-only (VMs, networks)
    "roles/storage.objectViewer",     # GCS object read (logs, exports)
    "roles/cloudbuild.builds.viewer", # Cloud Build build history
    "roles/cloudscheduler.viewer",    # Scheduled jobs (cron triggers)
    "roles/secretmanager.viewer",     # Secret *metadata* only — NOT secretAccessor
    "roles/pubsub.viewer",            # Pub/Sub topic + subscription metadata
  ]
}

resource "google_organization_iam_member" "agent_readonly_org_roles" {
  for_each = toset(local.agent_readonly_org_roles)
  org_id   = var.gcp_org_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.agent_readonly.email}"
}

# ── One-time state adoption (manual `terraform import`) ──────────────────────
# The agent-readonly SA, its Token Creator grant, and the org-level bindings
# were created manually in production before this file existed. To adopt the
# existing live resources into state without re-creation (which would fail
# with "already exists" from Google IAM), run the commands below ONCE from
# `terraform/` before the first `terraform apply` that includes this file.
#
# Why manual import and not `import` blocks: a `for_each` `import` block over
# the desired binding set forces Terraform to attempt an import for every
# desired member — including new impersonators or new org roles that do not
# yet exist in the live policy — and the plan fails with "Cannot import
# non-existent remote object" before any create path runs. Manual imports
# keep adoption strictly opt-in, and the normal create path handles any new
# binding that is not already present in the live policy. This also avoids
# baking the production `mento-monitoring` project ID into resource-level
# `import` IDs, which would be incorrect when `gcp_project_id` is overridden
# for a scratch / DR setup.
#
# Substitute `$PROJECT` / `$ORG` with the values from your `terraform.tfvars`
# (`var.gcp_project_id`, `var.gcp_org_id`):
#
#   PROJECT=mento-monitoring  # var.gcp_project_id
#   ORG=599540483579          # var.gcp_org_id
#   SA="agent-readonly@${PROJECT}.iam.gserviceaccount.com"
#
#   terraform import \
#     'google_service_account.agent_readonly' \
#     "projects/${PROJECT}/serviceAccounts/${SA}"
#
#   # Repeat per impersonator currently present in the live policy. The
#   # default `group:eng@mentolabs.xyz` is what production should look like
#   # after this PR; if the live grant is on a different principal (e.g. the
#   # original `user:philip.paetz@...`), import that principal here and let
#   # Terraform plan the swap to the eng group on the next apply.
#   MEMBER='group:eng@mentolabs.xyz'
#   terraform import \
#     "google_service_account_iam_member.agent_readonly_token_creators[\"${MEMBER}\"]" \
#     "projects/${PROJECT}/serviceAccounts/${SA} roles/iam.serviceAccountTokenCreator ${MEMBER}"
#
#   # Adopt only org-role bindings that already exist in the live policy. New
#   # roles added to `local.agent_readonly_org_roles` will be created normally
#   # by the next `terraform apply` without an import step.
#   for role in roles/browser roles/cloudasset.viewer roles/iam.securityReviewer \
#               roles/serviceusage.serviceUsageConsumer roles/run.viewer \
#               roles/logging.viewer roles/monitoring.viewer \
#               roles/artifactregistry.reader roles/compute.viewer \
#               roles/storage.objectViewer roles/cloudbuild.builds.viewer \
#               roles/cloudscheduler.viewer roles/secretmanager.viewer \
#               roles/pubsub.viewer; do
#     terraform import \
#       "google_organization_iam_member.agent_readonly_org_roles[\"$role\"]" \
#       "${ORG} $role serviceAccount:${SA}" || true
#   done
#
# For a fresh org / DR bootstrap with no live resources, skip the imports
# above entirely — `terraform apply` will create everything from scratch.
