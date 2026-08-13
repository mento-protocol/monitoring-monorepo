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

# Rotation lever. `scripts/tf-platform-plan-guard.mjs` parses platform Terraform
# arguments against a strict allowlist and rejects everything outside it, so
# `-replace` is not available on this stack. Without a source-driven trigger the
# only way to roll this credential would be a manual Grafana console action —
# exactly what [ADR 0030](../docs/adr/0030-iac-before-cli-secrets.md) forbids.
# Increment the counter through an approved current-`main` plan/apply; the same
# apply mints the replacement and pushes it to Vercel.
resource "terraform_data" "grafana_dashboard_reader_token_rotation" {
  input = var.grafana_dashboard_reader_token_rotation_counter
}

# No `seconds_to_live`: the token does not expire on its own. A self-expiring
# token would silently stop the history endpoints on a date nothing watches,
# and the failure would look like a Grafana outage rather than an expiry. The
# counter above is the deliberate, reviewed rotation path instead.
#
# Replacement destroys the old token before creating the new one — Grafana
# scopes token names to their service account, so `create_before_destroy` would
# collide on the name. The gap is bounded by the apply and lands only on the
# history endpoints, which ADR 0063 requires the board to survive.
resource "grafana_service_account_token" "dashboard_reader" {
  name               = "monitoring-dashboard-reader"
  service_account_id = grafana_service_account.dashboard_reader.id

  lifecycle {
    replace_triggered_by = [
      terraform_data.grafana_dashboard_reader_token_rotation.output,
    ]
  }
}
