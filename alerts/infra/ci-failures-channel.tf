###############################
# CI failures Slack channel    #
###############################
#
# A dedicated `#ci-failures` channel for the
# `.github/workflows/notify-slack-on-main-failure.yml` workflow to post into
# when any push-to-main workflow conclusion is `failure`. Separate from
# `#alerts-critical` / `#alerts-infra` because CI failures are different
# operational signal — they tell you "the deploy pipeline broke", not
# "production is degraded."
#
# Same restapi-against-Slack pattern as `channels/sentry-bridge/slack_channels.tf`
# (per-project channels). Reuses the existing `restapi.slack` provider in
# `providers.tf` and the same `var.slack_bot_token`. Required Slack scopes
# for the bot token: `channels:read`, `channels:manage`, `channels:join`
# (same as before — channel creation + archive), PLUS `chat:write.public`
# (new — so the GH Actions workflow can post into the channel without
# needing to be invited).
#
# IMPORTANT: After provisioning, expand the bot token's OAuth scopes in
# Slack admin → Apps → (your app) → OAuth & Permissions to include
# `chat:write.public`, then re-authorize. The token itself stays valid;
# the scopes attached to it grow. Update `slack_bot_token` in tfvars
# only if Slack re-issues the token (it usually doesn't on scope expansion).

resource "restapi_object" "ci_failures_channel" {
  provider = restapi.slack

  path        = "/conversations.create"
  create_path = "/conversations.create"
  read_path   = "/conversations.info?channel={id}"

  destroy_path   = "/conversations.archive?channel={id}"
  destroy_method = "POST"

  update_path   = ""
  update_method = "POST"

  data = jsonencode({
    name       = "ci-failures"
    is_private = false
  })

  id_attribute              = "channel/id"
  ignore_all_server_changes = true

  lifecycle {
    postcondition {
      condition     = self.api_response != null && try(jsondecode(self.api_response).ok, false) == true
      error_message = "Slack conversations.create failed for #ci-failures: ${try(jsondecode(self.api_response).error, "unknown")}"
    }
  }
}

# Ensure the channel-management bot is a member of #ci-failures. Without
# membership the `conversations.archive` call on destroy returns
# `not_in_channel`. `conversations.join` is idempotent (Slack returns
# `ok=true, already_in_channel=true` if the bot is already a member), so
# this is a no-op for freshly-created channels and only does real work
# for the import-recovery path.
#
# Note: posting to the channel from the GH Actions workflow does NOT
# require the bot to be a member — it uses `chat.postMessage` with
# `chat:write.public` scope which writes to any public channel without
# membership. This `conversations.join` is purely for the channel-
# management lifecycle (archive on destroy).
resource "restapi_object" "ci_failures_channel_member" {
  provider = restapi.slack

  path        = "/conversations.join"
  create_path = "/conversations.join"
  read_path   = "/conversations.info?channel={id}"

  destroy_path   = "/api.test"
  destroy_method = "POST"

  update_path   = ""
  update_method = "POST"

  data = jsonencode({
    channel = restapi_object.ci_failures_channel.id
  })

  id_attribute              = "channel/id"
  ignore_all_server_changes = true

  depends_on = [restapi_object.ci_failures_channel]

  lifecycle {
    postcondition {
      condition     = self.api_response != null && try(jsondecode(self.api_response).ok, false) == true
      error_message = "Slack conversations.join failed for #ci-failures: ${try(jsondecode(self.api_response).error, "unknown")}"
    }
  }
}

output "ci_failures_channel_id" {
  description = "Slack channel ID for #ci-failures (used by the notify-slack-on-main-failure workflow)"
  value       = restapi_object.ci_failures_channel.id
}
