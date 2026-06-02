###############################
# CI failures Slack channel    #
###############################
#
# A dedicated `#ci-failures` channel for main-branch GitHub Actions failures
# from `.github/workflows/notify-slack-on-main-failure.yml`. Terraform
# apply-pending summaries are intentionally routed to `#ci-operations` instead
# so approval waits do not look like failed builds.
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
  description = "Slack channel ID for #ci-failures (used by GitHub Actions operational notifications)"
  value       = restapi_object.ci_failures_channel.id
}

###############################
# Auto-invite @eng on creation #
###############################
#
# Resolve the `@eng` usergroup to its current member user IDs at plan time
# via Slack's `usergroups.list` + `usergroups.users.list`, then invite all
# of them to #ci-failures with one `conversations.invite` call. Lifecycle
# replace_triggered_by on the resolved member list means membership
# changes upstream (someone joins / leaves @eng in Slack admin) re-fire
# the invite on the next apply, keeping the channel roster in sync.
#
# IMPORTANT: the bot token needs `usergroups:read` scope (new) in addition
# to `channels:read/manage/join` and `chat:write.public`. Without it the
# data sources below return `missing_scope` and the plan fails loudly.
#
# Why `hashicorp/http` data sources instead of `restapi`: `restapi_object`
# is a managed resource — overkill for read-only Slack API GETs we just
# want to resolve at plan time. The `http` provider's `data` source is
# the lightweight, side-effect-free read mechanism for arbitrary HTTP
# endpoints.

data "http" "slack_usergroups_list" {
  url = "https://slack.com/api/usergroups.list"
  request_headers = {
    Authorization = "Bearer ${var.slack_bot_token}"
  }
}

data "http" "slack_eng_usergroup_members" {
  url = "https://slack.com/api/usergroups.users.list?usergroup=${local.eng_usergroup_id}"
  request_headers = {
    Authorization = "Bearer ${var.slack_bot_token}"
  }
}

locals {
  # Look up the @eng usergroup by handle. Slack's `handle` is the bare
  # name (no leading `@`). If the team renames @eng someday, change this
  # one constant.
  eng_usergroup_handle = "eng"

  # Validate the list call succeeded — if the bot is missing the
  # `usergroups:read` scope, Slack returns 200 OK with {"ok": false,
  # "error": "missing_scope"} (per the same 200-on-logical-error footgun
  # documented in the [restapi+slack reference]
  # (../../channels/sentry-bridge/slack_channels.tf)). The lookups below
  # will fail with a NULL/length-zero result if we don't guard here.
  eng_usergroup_id = [
    for ug in jsondecode(data.http.slack_usergroups_list.response_body).usergroups :
    ug.id if ug.handle == local.eng_usergroup_handle
  ][0]

  # Sort the user IDs before joining so the CSV is a STABLE membership
  # fingerprint. Slack's `usergroups.users.list` does not promise a stable
  # ordering across calls — `force_new` on the raw join would treat a
  # reordered list as a membership change and recreate
  # `ci_failures_invite_eng` on every plan, re-firing `conversations.invite`
  # for no real change. Lexicographic sort by Slack user ID is deterministic.
  eng_user_ids_csv = join(",", sort(jsondecode(data.http.slack_eng_usergroup_members.response_body).users))
}

# POST conversations.invite once at create time, with the current @eng
# member list. The `triggers`-style behaviour comes from `force_new`:
# Terraform recreates the invite resource whenever the resolved member
# CSV changes, which makes Slack send fresh invites to any newly-added
# @eng members on the next apply.
#
# `conversations.invite` returns ok=true on success. If a user is already
# a member it returns ok=false with `errors: [{"user": "U123", "error":
# "already_in_channel"}]` — the postcondition treats that as benign.
#
# `count` guards the empty-@eng case: when the usergroup is temporarily
# empty (everyone removed; the CSV becomes ""), Slack's documented
# `conversations.invite` requires `users` (1–1000), so the call would
# fail with `no_user` and block unrelated applies. Skipping the resource
# entirely when there's nobody to invite is a safer default than
# erroring out on routine usergroup churn.
resource "restapi_object" "ci_failures_invite_eng" {
  count = local.eng_user_ids_csv == "" ? 0 : 1

  provider = restapi.slack

  path        = "/conversations.invite"
  create_path = "/conversations.invite"
  # No-op read: this resource's stored ID is the Slack response `ok` flag,
  # not a channel ID, because the accepted all-already-in-channel path has no
  # `channel.id` to persist. Reading `conversations.info?channel={id}` after
  # apply would therefore query `channel=true`/`false` and fail every later
  # plan. Treat the invite as a one-shot trigger whose refresh only proves the
  # Slack token/API are reachable.
  read_path = "/api.test"

  # No-op destroy — leaving @eng in the channel on `terraform destroy` is
  # the right default (their membership isn't ours to revoke).
  destroy_path   = "/api.test"
  destroy_method = "POST"

  update_path   = ""
  update_method = "POST"

  data = jsonencode({
    channel = restapi_object.ci_failures_channel.id
    users   = local.eng_user_ids_csv
    # `force = true` makes Slack skip invalid user IDs and continue
    # inviting the valid ones, instead of erroring out on the first bad
    # ID. With a usergroup-resolved member list the IDs should all be
    # valid, but `force` is the safer default for a fan-out invite —
    # one stale user in @eng won't fail the whole apply.
    force = true
  })

  # Force-new on the member CSV: when @eng membership changes upstream,
  # the resolved CSV changes, Terraform recreates this resource, and the
  # invite POSTs again with the fresh member list.
  force_new = [
    local.eng_user_ids_csv,
  ]

  # `id_attribute = "ok"` (not "channel/id") because Slack's
  # `conversations.invite` response shape DIVERGES across the two
  # success paths the postcondition accepts: on `ok=true` it includes
  # `channel: {id: ...}`, but on the legitimate `ok=false +
  # all-already_in_channel` benign case it returns `{ok, errors}` with
  # NO `channel` object. `channel/id` would fail to extract on the
  # second path and the provider would error BEFORE the postcondition
  # runs, breaking applies during routine @eng remove-only churn (when
  # everyone else is already a member). `ok` is always present in both
  # paths; the resulting `"true"` / `"false"` ID string is meaningless
  # but harmless. Since that ID is not a Slack channel ID, `read_path`
  # uses `/api.test` as a no-op refresh; we recreate via `force_new` on
  # the member CSV, so ID stability across reads isn't load-bearing.
  id_attribute              = "ok"
  ignore_all_server_changes = true

  depends_on = [restapi_object.ci_failures_channel_member]

  lifecycle {
    # Accept either `ok == true` (every user newly invited) OR `ok == false`
    # with a NON-EMPTY `errors` array whose entries are ALL
    # `already_in_channel`. With `force = true`, Slack invites all the
    # users it can and lists only the per-user failures in `errors`, so a
    # mixed case (3 newly invited, 2 already members) returns
    # `ok: false, errors: [<two already_in_channel entries>]` — length of
    # `errors` is the count of failures, NOT the count of users requested.
    # Don't gate on length equality; gate on "all listed errors are benign."
    #
    # The non-empty guard (`length > 0`) closes a vacuous-truth hole:
    # `alltrue([])` is `true` in Terraform, so without it a real failure
    # like `{"ok": false, "error": "missing_scope"}` (top-level error,
    # NO `errors` array) would silently pass the postcondition.
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
      error_message = "Slack conversations.invite failed for #ci-failures @eng: ${try(jsondecode(self.api_response).error, try(jsondecode(self.api_response).errors[0].error, "unknown"))}"
    }
  }
}
