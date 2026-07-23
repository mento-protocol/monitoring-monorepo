# ⚠️  IMPORTANT: Terraform manages webhook CREATION only — not filter updates.
#
# If you see "unexpected response code '522'" on restapi_object.quicknode_webhook_*:
# 522 is Cloudflare's "connection timed out" (QuickNode's origin didn't respond in time).
# Retry `terraform apply`; it is often transient.
#
# If you see "429 Rate limit exceeded" on quicknode_webhook_*:
# Each webhook refresh uses multiple API calls; infra/versions.tf sets provider restapi { rate_limit = 1 }
# so Terraform does not burst QuickNode. If 429 still appears, check QuickNode status or API key quotas.
#
#
# The `filter_function` values below are derived from the reviewed filter files with
# `filebase64` and used only during initial bootstrap. Updates use `update_data`
# (destination only) so we never PATCH `filter_function` on template webhooks.
# `ignore_all_server_changes` reduces drift noise from server-only fields.
#
# CANONICAL WORKFLOWS:
#
# To UPDATE a webhook filter:
#   1. Edit the comment header in infra/quicknode-filter-functions/<webhook>.js
#   2. Run: ./bin/deploy-quicknode-filter.sh --webhook <healthcheck|governor>
#   (No pause/downtime needed — template updates are applied live.)
#
# To RECREATE a webhook (e.g. after accidental deletion):
#   1. Comment out the resource block below and run `terraform apply` to remove it
#   2. Uncomment and run `terraform apply`; filebase64 loads the current filter source
#   3. Run deploy-quicknode-filter.sh to apply the current filter config on top
#
# Template-based webhooks: PATCH /webhooks/{id} must NOT include `filter_function`
# (API returns 400 — use ./bin/deploy-quicknode-filter.sh for ABI/contracts). We set
# `update_data` to only destination fields so applies can update the Cloud Function URL
# without touching the filter.


locals {
  qn_watchdog_destination_attributes = {
    url            = google_cloudfunctions2_function.watchdog_notifications.service_config[0].uri
    security_token = var.quicknode_security_token
    compression    = "none"
  }
}

# A healthcheck webhook to ensure Quicknode is operating as expected.
# We use a webhook for `MedianUpdated` events for the CELO/USD feed on our SortedOracles contract,
# Because we know with reasonable certainty that the feed will update every couple of minutes.
resource "restapi_object" "quicknode_webhook_healthcheck" {
  path = "/webhooks/rest/v1/webhooks"

  # Configure update path and method according to QuickNode API
  update_path   = "/webhooks/rest/v1/webhooks/{id}"
  update_method = "PATCH"

  # Ignore server-added fields like created_at, updated_at, sequence to prevent spurious diffs and update attempts
  # QuickNode API rejects updates to active webhooks, so this avoids unnecessary failures on subsequent applies
  ignore_all_server_changes = true

  # Serialize with governor so we don't hit QuickNode rate limit (429) when both webhooks are read/updated close together
  depends_on = [restapi_object.quicknode_webhook_governor]

  update_data = jsonencode({
    destination_attributes = local.qn_watchdog_destination_attributes
  })

  data = jsonencode({
    name    = "SortedOracles"
    network = "celo-mainnet"
    # Derive the bootstrap blob from the reviewed filter source.
    filter_function = filebase64("${path.module}/quicknode-filter-functions/sorted-oracles.js")
    status          = "active"

    destination_attributes = local.qn_watchdog_destination_attributes
  })

  lifecycle {
    create_before_destroy = true
  }
}

# Watches for new events on the Governor contract https://celoscan.io/address/0x47036d78bB3169b4F5560dD77BF93f4412A59852
resource "restapi_object" "quicknode_webhook_governor" {
  path = "/webhooks/rest/v1/webhooks"

  # Configure update path and method according to QuickNode API
  update_path   = "/webhooks/rest/v1/webhooks/{id}"
  update_method = "PATCH"

  # Ignore server-added fields like created_at, updated_at, sequence to prevent spurious diffs and update attempts
  # QuickNode API rejects updates to active webhooks, so this avoids unnecessary failures on subsequent applies
  ignore_all_server_changes = true

  update_data = jsonencode({
    destination_attributes = local.qn_watchdog_destination_attributes
  })

  data = jsonencode({
    name    = "MentoGovernor"
    network = "celo-mainnet"
    # Derive the bootstrap blob from the reviewed filter source.
    filter_function = filebase64("${path.module}/quicknode-filter-functions/governor.js")
    status          = "active"

    destination_attributes = local.qn_watchdog_destination_attributes
  })

  lifecycle {
    create_before_destroy = true
  }
}
