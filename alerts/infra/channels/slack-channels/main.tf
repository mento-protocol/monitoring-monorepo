####################
# Slack Channels   #
####################

resource "restapi_object" "channel" {
  for_each = var.channels
  provider = restapi.slack

  path        = "/conversations.create"
  create_path = "/conversations.create"
  read_path   = "/conversations.info?channel={id}"

  destroy_path   = "/conversations.archive?channel={id}"
  destroy_method = "POST"

  update_path   = ""
  update_method = "POST"

  data = jsonencode({
    name       = each.value.name
    is_private = each.value.is_private
  })

  id_attribute              = "channel/id"
  ignore_all_server_changes = true

  lifecycle {
    postcondition {
      condition     = self.api_response != null && try(jsondecode(self.api_response).ok, false) == true
      error_message = "Slack conversations.create failed for #${each.value.name}: ${try(jsondecode(self.api_response).error, "unknown")}"
    }
  }
}

resource "restapi_object" "channel_member" {
  for_each = var.channels
  provider = restapi.slack

  path        = "/conversations.join"
  create_path = "/conversations.join"
  read_path   = "/conversations.info?channel={id}"

  # Keep bot membership until the channel resource archives the channel.
  destroy_path   = "/api.test"
  destroy_method = "POST"

  update_path   = ""
  update_method = "POST"

  data = jsonencode({
    channel = restapi_object.channel[each.key].id
  })

  id_attribute              = "channel/id"
  ignore_all_server_changes = true

  depends_on = [restapi_object.channel]

  lifecycle {
    postcondition {
      condition     = self.api_response != null && try(jsondecode(self.api_response).ok, false) == true
      error_message = "Slack conversations.join failed for #${each.value.name}: ${try(jsondecode(self.api_response).error, "unknown")}"
    }
  }
}
