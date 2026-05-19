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
#     logging, monitoring, artifact registry, compute). Cloud Asset
#     Inventory does most of the metadata lifting; the service viewer roles
#     are scoped to read-only verbs only. GCS object *payload* reads are
#     intentionally NOT granted at the org level — bucket/object metadata is
#     covered by `roles/cloudasset.viewer`, and payload reads are opt-in per
#     project via `var.agent_readonly_storage_object_projects`.
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

# Opt-in, project-scoped GCS object payload read access. Org-wide
# `roles/storage.objectViewer` is deliberately NOT granted (see role audit in
# `local.agent_readonly_org_roles`): it would let the agent read the contents
# of every object in every bucket under the org, including any bucket that
# happens to hold secrets, customer data, backups, or SA keys. Object metadata
# (names, sizes, ACLs, bucket structure) is already covered by
# `roles/cloudasset.viewer` at the org level, which is enough for most
# investigations. When a specific investigation needs to read actual object
# payloads (e.g. exported logs, public-data buckets), grant
# `roles/storage.objectViewer` here on the project(s) that own those buckets.
# Empty by default — fail closed.
variable "agent_readonly_storage_object_projects" {
  description = <<-EOT
    Project IDs in which the agent-readonly SA is granted
    `roles/storage.objectViewer` (object payload read). Use only for projects
    whose buckets the agent legitimately needs to read object contents from
    (log exports, public datasets). Leave empty to deny object payload access
    everywhere; metadata visibility via `roles/cloudasset.viewer` is unaffected.
  EOT
  type        = list(string)
  default     = []
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
    "roles/run.viewer",              # Cloud Run services, revisions, traffic
    "roles/logging.viewer",          # Cloud Logging entries + log-based metrics
    "roles/monitoring.viewer",       # Cloud Monitoring dashboards + metrics
    "roles/artifactregistry.reader", # Artifact Registry repos + images
    "roles/compute.viewer",          # Compute Engine read-only (VMs, networks)
    # NOTE: `roles/storage.objectViewer` is deliberately NOT granted at the org
    # level — it would permit object payload reads across every bucket under
    # the org (including any bucket holding secrets, customer data, backups, or
    # SA keys). GCS bucket + object *metadata* is already covered by
    # `roles/cloudasset.viewer` above. When a specific investigation needs
    # object payload access, opt in per-project via
    # `var.agent_readonly_storage_object_projects` (project-scoped binding
    # below).
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

# ── Opt-in project-scoped GCS object payload read ────────────────────────────
# Granted only on projects explicitly listed in
# `var.agent_readonly_storage_object_projects`. Default empty list = no
# object payload access anywhere; metadata-level visibility is still provided
# org-wide by `roles/cloudasset.viewer`.
resource "google_project_iam_member" "agent_readonly_storage_object_viewer" {
  for_each = toset(var.agent_readonly_storage_object_projects)
  project  = each.value
  role     = "roles/storage.objectViewer"
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
#   # Adopt the Token Creator grant. `google_service_account_iam_member` is
#   # non-authoritative and `for_each` keys instances by member, so Terraform
#   # only manages bindings for members listed in `var.agent_readonly_impersonators`.
#   # Any *other* members carrying the Token Creator role on this SA in the live
#   # policy are invisible to Terraform and will silently persist — handle them
#   # explicitly below.
#   #
#   # Step 1: inspect the live policy to see who currently holds Token Creator
#   # on the SA. On a fresh bootstrap with no live SA this returns empty and the
#   # rest of this section is a no-op.
#   gcloud iam service-accounts get-iam-policy "$SA" --project="$PROJECT" \
#     --flatten='bindings[].members' \
#     --filter='bindings.role:roles/iam.serviceAccountTokenCreator' \
#     --format='value(bindings.members)'
#
#   # Step 2: for each member listed above that is ALSO in
#   # `var.agent_readonly_impersonators` (e.g. the default `group:eng@mentolabs.xyz`
#   # once it has been granted manually, or any new members added to the variable),
#   # import the corresponding for_each instance. Re-run per member as needed:
#   MEMBER='group:eng@mentolabs.xyz'
#   terraform import \
#     "google_service_account_iam_member.agent_readonly_token_creators[\"${MEMBER}\"]" \
#     "projects/${PROJECT}/serviceAccounts/${SA} roles/iam.serviceAccountTokenCreator ${MEMBER}"
#
#   # Step 3: explicitly delete any legacy Token Creator members that are NOT in
#   # `var.agent_readonly_impersonators` and therefore unmanaged by Terraform.
#   # Production was originally bootstrapped with a single user grant
#   # (`user:philip.paetz@mentolabs.xyz`); the default impersonator list is now
#   # the eng group. Because `google_service_account_iam_member` is
#   # non-authoritative, Terraform will NOT plan removal of that legacy user
#   # grant on its own — leaving philip with permanent SA impersonation outside
#   # of group membership. Run this AFTER confirming Terraform has applied
#   # (or imported) the desired group binding, so impersonation continues to
#   # work for the engineering org throughout the swap. On a fresh bootstrap
#   # with no legacy user grant, gcloud exits non-zero with NOT_FOUND, which is
#   # the expected absent state — the `grep -q NOT_FOUND` filter ignores only
#   # that specific case and re-raises any other failure (permission denied,
#   # wrong project, transient API error) instead of papering over it.
#   LEGACY_MEMBER='user:philip.paetz@mentolabs.xyz'
#   if ! err=$(gcloud iam service-accounts remove-iam-policy-binding "$SA" \
#         --project="$PROJECT" \
#         --member="$LEGACY_MEMBER" \
#         --role="roles/iam.serviceAccountTokenCreator" 2>&1); then
#     if ! echo "$err" | grep -q -E 'NOT_FOUND|Policy binding .* does not exist'; then
#       echo "$err" >&2
#       exit 1
#     fi
#   fi
#
#   # Step 4: fail closed if the legacy user grant is still present. Empty
#   # output = success; any output means the cleanup did not take effect and
#   # the SA still carries the legacy impersonator — abort adoption so the
#   # operator investigates before continuing. Mirrors the org-level
#   # `roles/viewer` and `roles/storage.objectViewer` post-checks below.
#   remaining=$(gcloud iam service-accounts get-iam-policy "$SA" --project="$PROJECT" \
#     --flatten='bindings[].members' \
#     --filter="bindings.role:roles/iam.serviceAccountTokenCreator AND bindings.members:${LEGACY_MEMBER}" \
#     --format='value(bindings.members)')
#   if [ -n "$remaining" ]; then
#     echo "legacy ${LEGACY_MEMBER} still holds roles/iam.serviceAccountTokenCreator on ${SA}: ${remaining}" >&2
#     exit 1
#   fi
#
#   # Adopt only org-role bindings that already exist in the live policy. New
#   # roles added to `local.agent_readonly_org_roles` will be created normally
#   # by the next `terraform apply` without an import step.
#   for role in roles/browser roles/cloudasset.viewer roles/iam.securityReviewer \
#               roles/serviceusage.serviceUsageConsumer roles/run.viewer \
#               roles/logging.viewer roles/monitoring.viewer \
#               roles/artifactregistry.reader roles/compute.viewer \
#               roles/cloudbuild.builds.viewer \
#               roles/cloudscheduler.viewer roles/secretmanager.viewer \
#               roles/pubsub.viewer; do
#     terraform import \
#       "google_organization_iam_member.agent_readonly_org_roles[\"$role\"]" \
#       "${ORG} $role serviceAccount:${SA}" || true
#   done
#
#   # Strip any legacy org-level `roles/storage.objectViewer` grant on this SA.
#   # Earlier revisions of this file (and any hand-bootstrapped policies) bound
#   # object payload reads at the org level; the curated set in
#   # `local.agent_readonly_org_roles` deliberately omits it because it would
#   # let the SA read object payloads across every bucket under the org. Object
#   # payload access is now opt-in per project via
#   # `var.agent_readonly_storage_object_projects`. As with the legacy
#   # `roles/viewer` cleanup below, the adoption loop only imports curated
#   # roles, so a pre-existing org-level `roles/storage.objectViewer` binding
#   # would persist invisible to Terraform unless removed explicitly here.
#   # Member-scoped removal — other principals' bindings for the same role are
#   # untouched.
#   if ! err=$(gcloud organizations remove-iam-policy-binding "$ORG" \
#         --member="serviceAccount:${SA}" \
#         --role="roles/storage.objectViewer" 2>&1); then
#     if ! echo "$err" | grep -q -E 'NOT_FOUND|Policy binding .* does not exist'; then
#       echo "$err" >&2
#       exit 1
#     fi
#   fi
#
#   # Mandatory post-check: fail closed if the legacy org-level
#   # `roles/storage.objectViewer` binding still lists this SA.
#   remaining=$(gcloud organizations get-iam-policy "$ORG" \
#     --flatten='bindings[].members' \
#     --filter="bindings.role:roles/storage.objectViewer AND bindings.members:serviceAccount:${SA}" \
#     --format='value(bindings.members)')
#   if [ -n "$remaining" ]; then
#     echo "legacy org-level roles/storage.objectViewer binding for serviceAccount:${SA} still present on org ${ORG}: ${remaining}" >&2
#     exit 1
#   fi
#
#   # Strip the legacy org-level basic `roles/viewer` grant that the SA carried
#   # under its original hand-created form. Earlier revisions of this file bound
#   # `roles/viewer` at the org; the current curated set in
#   # `local.agent_readonly_org_roles` deliberately omits it (Checkov CKV_GCP_115
#   # forbids basic roles at the org level and the predefined roles above cover
#   # the read surface investigators need). Because the adoption loop above only
#   # imports curated roles, a pre-existing `roles/viewer` binding would remain
#   # in the live IAM policy with no Terraform-managed counterpart — Terraform
#   # would never plan its removal and the SA would silently retain org-wide
#   # basic read access. Remove it explicitly here, member-scoped so no other
#   # principal's `roles/viewer` binding is touched. Authoritative resources
#   # (`google_organization_iam_binding`) are intentionally avoided for the
#   # same reason: they would overwrite the full member list for the role.
#   #
#   # `remove-iam-policy-binding` exits non-zero if the binding is absent, which
#   # is the expected state on a fresh org / DR bootstrap or after this cleanup
#   # has already been run. We only want to ignore that specific case — other
#   # failures (permission denied, wrong org ID, transient API errors) MUST
#   # surface so cleanup never silently no-ops while the legacy grant lingers.
#   if ! err=$(gcloud organizations remove-iam-policy-binding "$ORG" \
#         --member="serviceAccount:${SA}" \
#         --role="roles/viewer" 2>&1); then
#     if ! echo "$err" | grep -q -E 'NOT_FOUND|Policy binding .* does not exist'; then
#       echo "$err" >&2
#       exit 1
#     fi
#   fi
#
#   # Mandatory post-check: fail closed if the legacy org-level basic
#   # `roles/viewer` binding still lists this SA. Empty output = success; any
#   # output means cleanup did not take effect (and other principals' viewer
#   # grants, if any, are untouched by member-scoped removal above).
#   remaining=$(gcloud organizations get-iam-policy "$ORG" \
#     --flatten='bindings[].members' \
#     --filter="bindings.role:roles/viewer AND bindings.members:serviceAccount:${SA}" \
#     --format='value(bindings.members)')
#   if [ -n "$remaining" ]; then
#     echo "legacy roles/viewer binding for serviceAccount:${SA} still present on org ${ORG}: ${remaining}" >&2
#     exit 1
#   fi
#
# For a fresh org / DR bootstrap with no live resources, skip the imports
# above entirely — `terraform apply` will create everything from scratch. The
# legacy `user:` Token Creator cleanup, the org-level `roles/viewer` cleanup,
# and the org-level `roles/storage.objectViewer` cleanup are also safe to run
# on a fresh bootstrap: each tolerates only the specific "binding absent" /
# NOT_FOUND case and re-raises any other gcloud failure, so they no-op
# cleanly when there is nothing to remove and surface real errors otherwise.
# They exist solely to clean up the previously hand-created production
# identity (and any earlier revision of this file that bound those roles).
