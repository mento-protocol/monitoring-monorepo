###################################
# Sentry triage Slack channel      #
###################################
#
# A dedicated `#sentry-triage` channel for the per-run Sentry triage verdict
# digest from `.github/workflows/sentry-triage-agent.yml`. The digest used to
# post to `#engineering`; it moved here so triage traffic stops competing with
# general engineering discussion in a channel nobody can reasonably mute.
#
# Same restapi-against-Slack pattern as `ci-failures-channel.tf`. Reuses the
# existing `restapi.slack` provider in `providers.tf` and the same
# `var.slack_bot_token` — no new secret, and no new OAuth scopes beyond the
# `channels:read`, `channels:manage`, `channels:join`, `chat:write.public`, and
# `usergroups:read` set that `#ci-failures` already required.
#
# The workflow posts with `chat:write.public`, so it does not need the bot to be
# a member. The `conversations.join` below exists only so `conversations.archive`
# on destroy does not fail with `not_in_channel`.

resource "restapi_object" "sentry_triage_channel" {
  provider = restapi.slack

  path        = "/conversations.create"
  create_path = "/conversations.create"
  read_path   = "/conversations.info?channel={id}"

  destroy_path   = "/conversations.archive?channel={id}"
  destroy_method = "POST"

  update_path   = ""
  update_method = "POST"

  data = jsonencode({
    name       = "sentry-triage"
    is_private = false
  })

  id_attribute              = "channel/id"
  ignore_all_server_changes = true

  lifecycle {
    postcondition {
      condition     = self.api_response != null && try(jsondecode(self.api_response).ok, false) == true
      error_message = "Slack conversations.create failed for #sentry-triage: ${try(jsondecode(self.api_response).error, "unknown")}"
    }
  }
}

# Channel-management membership only — see the header note. `conversations.join`
# is idempotent (Slack returns `ok=true, already_in_channel=true`), so this is a
# no-op after the first apply and does real work only on the import-recovery path.
resource "restapi_object" "sentry_triage_channel_member" {
  provider = restapi.slack

  path        = "/conversations.join"
  create_path = "/conversations.join"
  read_path   = "/conversations.info?channel={id}"

  destroy_path   = "/api.test"
  destroy_method = "POST"

  update_path   = ""
  update_method = "POST"

  data = jsonencode({
    channel = restapi_object.sentry_triage_channel.id
  })

  id_attribute              = "channel/id"
  ignore_all_server_changes = true

  depends_on = [restapi_object.sentry_triage_channel]

  lifecycle {
    postcondition {
      condition     = self.api_response != null && try(jsondecode(self.api_response).ok, false) == true
      error_message = "Slack conversations.join failed for #sentry-triage: ${try(jsondecode(self.api_response).error, "unknown")}"
    }
  }
}

output "sentry_triage_channel_id" {
  description = "Slack channel ID for #sentry-triage (used by the Sentry triage verdict digest)"
  value       = restapi_object.sentry_triage_channel.id
}

##########################################
# Auto-invite @eng on channel creation    #
##########################################
#
# Same one-shot invite as `#ci-failures`, reusing the `local.eng_user_ids_csv`
# membership fingerprint resolved in `ci-failures-channel.tf` (Terraform locals
# are module-scoped, so the `usergroups.list` / `usergroups.users.list` reads
# happen once for both channels rather than twice).
#
# Seeding the roster is deliberate: an unattended digest posting into an empty
# channel is worse than the noise it replaced. Anyone who does not want the
# traffic can mute or leave `#sentry-triage` — which is the whole point of
# splitting it out of `#engineering`, where leaving is not an option.
#
# Every quirk below (the `ok` id_attribute, the `/api.test` no-op read, the
# non-empty `errors` guard against `alltrue([]) == true`) is explained at length
# on `restapi_object.ci_failures_invite_eng`; read that resource before changing
# any of them here.
resource "restapi_object" "sentry_triage_invite_eng" {
  count = local.eng_user_ids_csv == "" ? 0 : 1

  provider = restapi.slack

  path        = "/conversations.invite"
  create_path = "/conversations.invite"
  read_path   = "/api.test"

  destroy_path   = "/api.test"
  destroy_method = "POST"

  update_path   = ""
  update_method = "POST"

  data = jsonencode({
    channel = restapi_object.sentry_triage_channel.id
    users   = local.eng_user_ids_csv
    force   = true
  })

  force_new = [
    local.eng_user_ids_csv,
  ]

  id_attribute              = "ok"
  ignore_all_server_changes = true

  depends_on = [restapi_object.sentry_triage_channel_member]

  lifecycle {
    postcondition {
      condition = (
        self.api_response != null && (
          try(jsondecode(self.api_response).ok, false) == true
          || (
            try(length(jsondecode(self.api_response).errors), 0) > 0
            && alltrue([
              for err in try(jsondecode(self.api_response).errors, []) :
              try(err.error, "") == "already_in_channel"
            ])
          )
        )
      )
      error_message = "Slack conversations.invite failed for #sentry-triage @eng: ${try(jsondecode(self.api_response).error, try(jsondecode(self.api_response).errors[0].error, "unknown"))}"
    }
  }
}
