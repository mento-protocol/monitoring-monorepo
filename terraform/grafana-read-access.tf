# ── Grafana Cloud read access for the dashboard ───────────────────────────────
#
# The peg board reads *current-state* evidence from the Metrics Bridge decision
# package ([ADR 0049](../docs/adr/0049-peg-decision-package-read-model.md)).
# Historical series and alert state history do not exist there by design, so the
# dashboard reads them from Grafana Cloud — the store ADR 0049 already names as
# authoritative for duration and state.
# [ADR 0063](../docs/adr/0063-dashboard-grafana-history-read-access.md) owns that
# boundary.
#
# WHY THIS STACK. `terraform.stacks.json` gives `platform` the dashboard Vercel
# project and its environment. This identity exists only to serve that project,
# and minting it here lets the token go straight from the resource that creates
# it to the environment variable that consumes it, inside one apply — the same
# shape `upstash_redis_database.address_labels.rest_token` already uses in
# `dashboard.tf`. `alerts/rules` owns alert rules and routing, `aegis` owns the
# Aegis dashboard and folder; neither owns a dashboard read credential, and
# either would need a cross-stack secret handoff this repo has no convention
# for (no `terraform_remote_state` reader exists in any stack).
#
# WHY A NEW SERVICE ACCOUNT. The Admin-role token that `alerts/rules` and
# `aegis` use provisions the whole Grafana org. Never reuse it as a runtime
# credential and never widen it. This service account is a separate identity
# with its own lifecycle, so revoking dashboard access is one `is_disabled` flip
# and never touches alert provisioning.
#
# This file holds every Viewer identity the platform stack mints. The second
# one, `hardin_reader` at the bottom, follows the same shape for the Hardin SRE
# agent and is delivered through Secret Manager instead of Vercel
# (`docs/notes/hardin-read-access.md`). Both stay on `Viewer`; neither is ever
# the Admin provisioning token.

resource "grafana_service_account" "dashboard_reader" {
  name = "monitoring-dashboard-reader"

  # Viewer is the least basic role that grants both capabilities the dashboard
  # needs: querying a datasource (`datasources:query`, for the Mimir range
  # queries behind the peg-history chart) and reading alert rules and instances
  # (for `GET /api/v1/rules/history`, the Loki-backed alert state history API).
  # Editor is the next role up and adds write access to dashboards, folders, and
  # alert rules — authority a read-only board must never hold. Grafana attaches
  # no scope to the token itself, so this role IS the boundary: widening it
  # widens every request the dashboard can make.
  role = "Viewer"

  is_disabled = false
}

# Rotation lever. `scripts/terraform/tf-platform-plan-guard.mjs` parses platform Terraform
# arguments against a strict allowlist and rejects everything outside it, so
# `-replace` is not available on this stack. Without a source-driven trigger the
# only way to roll this credential would be a manual Grafana console action —
# exactly what [ADR 0030](../docs/adr/0030-iac-before-cli-secrets.md) forbids.
# Increment the counter through an approved current-`main` plan/apply, then
# redeploy the dashboard (see below).
resource "terraform_data" "grafana_dashboard_reader_token_rotation" {
  input = var.grafana_dashboard_reader_token_rotation_counter
}

# No `seconds_to_live`: the token does not expire on its own. A self-expiring
# token would silently stop the history endpoints on a date nothing watches,
# and the failure would look like a Grafana outage rather than an expiry. The
# counter above is the deliberate, reviewed rotation path instead.
#
# ROTATION IS APPLY **PLUS** REDEPLOY. Replacement destroys the old token before
# creating the new one — Grafana scopes token names to their service account, so
# `create_before_destroy` would collide on the name. Writing a Vercel
# environment variable does not reach the running deployment either; only the
# next deployment reads it. Between the apply and that deployment, production
# still presents the revoked token and every history read fails. The redeploy is
# a step of the rotation, not a follow-up — `var.auth_secret_prev` documents the
# same two-step shape for the sibling Vercel secrets, and `docs/deployment.md`
# carries the ordered procedure.
#
# The window is deliberate. The reason to roll this credential is that it
# leaked, and revoking it immediately is the point; keeping the previous token
# alive across the redeploy would keep a known-exposed credential valid for the
# whole window. The cost stays inside the history endpoints, which ADR 0063
# requires the board to survive, and never touches current-state peg evidence.
resource "grafana_service_account_token" "dashboard_reader" {
  name               = "monitoring-dashboard-reader"
  service_account_id = grafana_service_account.dashboard_reader.id

  lifecycle {
    replace_triggered_by = [
      terraform_data.grafana_dashboard_reader_token_rotation.output,
    ]
  }
}

# ── Grafana Cloud read access for Hardin (read-only SRE agent) ───────────────
#
# Hardin is the in-house SRE agent on Philip's macOS gateway. It investigates
# incidents read-only and needs the same two Grafana capabilities the dashboard
# needs — datasource queries and alert rule/instance reads — and nothing more.
#
# WHY A SEPARATE IDENTITY FROM THE DASHBOARD. Reusing `dashboard_reader` would
# put one token in two places (a Vercel environment and Secret Manager) with two
# unrelated consumers, so a rotation forced by either side would break the
# other, and access review could not tell the dashboard's reads from the
# agent's. A second Viewer service account keeps revocation to one
# `is_disabled` flip that touches neither the dashboard nor alert provisioning.
#
# WHY SECRET MANAGER. No human has to handle this token. The dashboard's
# token travels resource → Vercel environment inside one apply; Hardin has no
# Vercel project, so its equivalent sink is a Secret Manager secret in the
# monitoring project that only `agent_readonly` may access. Hardin reaches it
# by impersonating `agent_readonly` (Token Creator grant in `agent-readonly.tf`),
# which is the identity chain every other Hardin read already uses. The secret
# payload terminates at the provider's write-only argument, so this resource
# adds no second copy of the token to Terraform state; the Grafana token
# resource itself remains the single sensitive state entry, exactly as for
# `dashboard_reader`. [ADR 0030](../docs/adr/0030-iac-before-cli-secrets.md)
# rules out `gcloud secrets versions add` or a Grafana-console token here.
#
# ACCEPTED BOUNDARY. Every principal in `var.agent_readonly_impersonators`
# (today the eng group and Hardin) can impersonate `agent_readonly` and
# therefore read this token, exactly as they can read everything else that SA
# sees. Engineers already hold their own Grafana logins, so this widens no
# Grafana surface for them, but Grafana access logs cannot tell a human who
# used this token from Hardin. Tightening that to a Hardin-only principal
# would mean granting `secretAccessor` to Hardin's key-bearing SA directly,
# which the documented chain deliberately avoids; revisit if the impersonator
# list grows beyond the eng group.

resource "grafana_service_account" "hardin_reader" {
  name = "hardin-sre-reader"

  # Viewer for the same reason as `dashboard_reader` above: it is the least
  # basic role that grants datasource queries and alert rule/instance reads.
  # Grafana attaches no scope to the token, so this role IS the boundary.
  role = "Viewer"

  is_disabled = false
}

# No `seconds_to_live`, for the same reason as the dashboard token: a silent
# expiry would look like a Grafana outage to the agent. Rotation is a reviewed
# bump of `var.grafana_hardin_reader_token_rotation_counter`; the platform
# argument allowlist rejects `-replace`, so that counter is the only way to
# roll this credential.
#
# ROTATION ORDER. Unlike `dashboard_reader`, this token does NOT use a
# `terraform_data` trigger with a fixed name. The Secret Manager version below
# carries `create_before_destroy`, and Terraform propagates that behaviour to
# every resource it depends on, so a fixed-name token would be asked to create
# its replacement while the old token still holds the name, and Grafana would
# reject the collision. Putting the counter in the name makes each replacement
# unique: one apply creates `hardin-sre-reader-<n+1>`, writes it as the new
# secret version, then disables the old version and destroys
# `hardin-sre-reader-<n>`. The old token stays valid only for those seconds.
# Hardin reads `latest` on every use and needs no redeploy.
resource "grafana_service_account_token" "hardin_reader" {
  name               = "hardin-sre-reader-${var.grafana_hardin_reader_token_rotation_counter}"
  service_account_id = grafana_service_account.hardin_reader.id
}

resource "google_secret_manager_secret" "hardin_grafana_reader_token" {
  project   = google_project.monitoring.project_id
  secret_id = "hardin-grafana-reader-token"

  replication {
    auto {}
  }

  depends_on = [google_project_service.secretmanager]
}

# The token enters this resource through the write-only argument and is never
# persisted by it; `secret_data_wo_version` tracks the reviewed rotation counter
# so the version is rewritten exactly when the token above is replaced. The
# previous version is disabled rather than destroyed only to keep the audit
# trail: it holds a Grafana token that the rotation already revoked, so
# re-enabling it recovers nothing. Recovery from a mistaken counter bump is to
# let the rotation complete (Hardin reads `latest`) or bump the counter again.
resource "google_secret_manager_secret_version" "hardin_grafana_reader_token" {
  secret                 = google_secret_manager_secret.hardin_grafana_reader_token.id
  secret_data_wo         = grafana_service_account_token.hardin_reader.key
  secret_data_wo_version = var.grafana_hardin_reader_token_rotation_counter
  deletion_policy        = "DISABLE"

  lifecycle {
    create_before_destroy = true
  }
}

# Secret-scoped, single-member accessor grant. `agent_readonly` holds only
# `roles/secretmanager.viewer` (metadata) at the org level by design; this is
# the one secret whose payload it may read. Hardin never receives
# `secretAccessor` directly: it must go through the Token Creator chain in
# `agent-readonly.tf`, so removing it from `var.agent_readonly_impersonators`
# also cuts its path to this token.
resource "google_secret_manager_secret_iam_member" "hardin_grafana_reader_token_accessor" {
  project   = google_project.monitoring.project_id
  secret_id = google_secret_manager_secret.hardin_grafana_reader_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.agent_readonly.email}"
}
