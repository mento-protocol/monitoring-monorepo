##########################################
# Deploy-notification bot membership     #
##########################################
#
# Joins this stack's Slack bot (var.slack_bot_token) to whichever channel
# the platform stack's TERRAFORM_APPLY_SLACK_CHANNEL variable routes the
# scripts/notify-terraform-apply.mjs apply-pending prompt to (see
# terraform/github-variables.tf and docs/notes/slack-github-subscriptions.md).
#
# `chat.postMessage` with `chat:write.public` (see ci-operations-channel.tf)
# only reaches PUBLIC channels without membership — a private channel, or a
# public channel the bot was never joined to, silently drops the message
# because the notify step runs with `continue-on-error: true`. Setting
# `deploy_notification_channel_id` to that channel's Slack ID joins the bot
# via IaC instead of relying on someone remembering to `/invite` it.
#
# `count`-gated: this resource does nothing until an operator sets the
# channel ID. It takes a channel ID directly (not a name) because it does
# not create the channel — the operator points it at an existing channel,
# same shape as `oncall_slack_channel_id` elsewhere in this stack.

resource "restapi_object" "deploy_notification_channel_member" {
  count = var.deploy_notification_channel_id != "" ? 1 : 0

  provider = restapi.slack

  path        = "/conversations.join"
  create_path = "/conversations.join"
  read_path   = "/conversations.info?channel={id}"

  destroy_path   = "/api.test"
  destroy_method = "POST"

  update_path   = ""
  update_method = "POST"

  data = jsonencode({
    channel = var.deploy_notification_channel_id
  })

  id_attribute              = "channel/id"
  ignore_all_server_changes = true

  lifecycle {
    postcondition {
      condition     = self.api_response != null && try(jsondecode(self.api_response).ok, false) == true
      error_message = "Slack conversations.join failed for deploy_notification_channel_id: ${try(jsondecode(self.api_response).error, "unknown")}"
    }
  }
}
