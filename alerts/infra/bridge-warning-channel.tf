# Slack channel lifecycle belongs to alerts-delivery; Grafana routing remains
# in alerts-rules. Apply this stack first, then verify the Grafana bot can post.
module "bridge_warning_channel" {
  source    = "./channels/slack-channels"
  providers = { restapi.slack = restapi.slack }
  channels  = { bridges = { name = "alerts-bridges", is_private = false } }
}

output "bridge_warning_channel_id" {
  description = "Slack channel ID for approved bridge-transfer warnings."
  value       = module.bridge_warning_channel.channel_ids.bridges
}

# Seed the same @eng roster used by existing operational channels.
resource "restapi_object" "bridge_warning_invite_eng" {
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
    channel = module.bridge_warning_channel.channel_ids.bridges
    users   = local.eng_user_ids_csv
    force   = true
  })

  force_new = [
    local.eng_user_ids_csv,
  ]

  id_attribute              = "ok"
  ignore_all_server_changes = true

  depends_on = [module.bridge_warning_channel]

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
      error_message = "Slack conversations.invite failed for #alerts-bridges @eng: ${try(jsondecode(self.api_response).error, try(jsondecode(self.api_response).errors[0].error, "unknown"))}"
    }
  }
}
