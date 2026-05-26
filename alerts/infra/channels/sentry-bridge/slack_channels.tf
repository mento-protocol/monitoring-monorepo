####################
# Slack Channels   #
####################
#
# One public Slack channel per auto-discovered Sentry project, created via
# Slack's `conversations.create` Web API endpoint. The `mastercard/restapi`
# provider is reused (same pattern as `channels/discord-channels/` for
# Discord webhooks and `onchain-event-listeners/` for QuickNode webhooks).
#
# Why restapi instead of a dedicated Slack provider:
#   - `pablovarela/slack` was the most-downloaded Slack TF provider but the
#     repo was archived 2026-02-04 with an unpatched CVE in its dependencies.
#   - `knowledge-work/slack` is a v0.0.1 fork by a solo maintainer.
#   - `mastercard/restapi` is already in this repo's lock + actively
#     maintained, so reusing it removes the new-provider bus-factor risk.
#
# Slack API quirks the resources below have to navigate:
#   - Slack returns HTTP 200 with `{"ok": false, "error": "..."}` on logical
#     errors (e.g. `name_taken`, `invalid_auth`). The `lifecycle.postcondition`
#     asserts `ok == true` so plan/apply fails loudly on real errors instead
#     of recording broken state.
#   - `conversations.archive` takes the channel ID as a query string, not in
#     the URL path. `destroy_path` interpolates `{id}` accordingly.
#   - Channels can only be archived, not deleted (Slack constraint). On a
#     `terraform destroy` the channel is archived; a re-apply would create
#     a fresh channel with a new ID (the archived one becomes a name-collision
#     hazard — unarchive manually first or rename if you ever recreate).
#   - Slack channels can't be "updated" in place via Terraform here — we
#     force recreation by setting `update_method = "POST"` (invalid for
#     updates) following the QuickNode pattern documented in
#     `onchain-event-listeners/WEBHOOK_STATE_MANAGEMENT.md`.

resource "restapi_object" "sentry_slack_channel" {
  for_each = local.projects
  provider = restapi.slack

  # POST https://slack.com/api/conversations.create  body: {"name": "sentry-<slug>", "is_private": false}
  path        = "/conversations.create"
  create_path = "/conversations.create"
  # `read_path` MUST be set to a real Slack endpoint. Without it the provider
  # defaults to GET <path>/{id} = `/conversations.create/<id>`, which is not a
  # valid Slack endpoint — Slack returns 404, the restapi provider treats that
  # as "resource gone", silently removes the channel from state, and the next
  # apply tries `conversations.create` again with a `name_taken` failure.
  read_path = "/conversations.info?channel={id}"
  # `destroy_method` MUST be POST. The provider defaults to DELETE, but Slack's
  # conversations.archive endpoint only accepts POST. Without this override
  # the destroy call 405s (or 200-ok:false), the resource is dropped from
  # state, and the channel is orphaned in the workspace.
  destroy_path   = "/conversations.archive?channel={id}"
  destroy_method = "POST"

  # Force recreation rather than attempted updates — Slack doesn't expose
  # rename/topic-update via this provider cleanly, and our channel config
  # is name-only so updates would be a no-op anyway. See the QuickNode
  # WEBHOOK_STATE_MANAGEMENT.md for the rationale on this pattern.
  update_path   = ""
  update_method = "POST"

  data = jsonencode({
    name       = "sentry-${each.key}"
    is_private = false
  })

  # Slack's response wraps the created channel: {"ok": true, "channel": {"id": "C123", ...}}
  id_attribute = "channel/id"

  # Slack adds server-side fields (created_at, creator, num_members, etc.)
  # that we don't want to track or react to. With the correct `read_path`
  # above, this prevents drift on those volatile fields.
  ignore_all_server_changes = true

  lifecycle {
    # On a `name_taken` failure (channel already exists), Slack returns
    # {"ok": false, "error": "name_taken"} with NO `channel.id` — the
    # provider's id_attribute extraction fails first and the apply errors out
    # with "Failed to find channel in returned data structure" before this
    # postcondition evaluates. The postcondition still serves as documentation
    # of the expected response shape AND catches any other ok=false case that
    # happens to include a `channel.id` (e.g. unusual Slack edge cases).
    postcondition {
      condition     = self.api_response != null && try(jsondecode(self.api_response).ok, false) == true
      error_message = "Slack conversations.create failed for #sentry-${each.key}: ${try(jsondecode(self.api_response).error, "unknown")}"
    }
  }
}
