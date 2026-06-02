################################
# CI operations Slack channel   #
################################
#
# A neutral home for GitHub Actions operational messages that are not failures,
# especially Terraform apply-pending summaries from the CI-applied Terraform
# stacks. Keep actual main-branch workflow failure alerts in #ci-failures.

resource "restapi_object" "ci_operations_channel" {
  provider = restapi.slack

  path        = "/conversations.create"
  create_path = "/conversations.create"
  read_path   = "/conversations.info?channel={id}"

  destroy_path   = "/conversations.archive?channel={id}"
  destroy_method = "POST"

  update_path   = ""
  update_method = "POST"

  data = jsonencode({
    name       = "ci-operations"
    is_private = false
  })

  id_attribute              = "channel/id"
  ignore_all_server_changes = true

  lifecycle {
    postcondition {
      condition     = self.api_response != null && try(jsondecode(self.api_response).ok, false) == true
      error_message = "Slack conversations.create failed for #ci-operations: ${try(jsondecode(self.api_response).error, "unknown")}"
    }
  }
}

# Join so lifecycle archive calls keep working. Posting uses chat:write.public
# and does not require membership.
resource "restapi_object" "ci_operations_channel_member" {
  provider = restapi.slack

  path        = "/conversations.join"
  create_path = "/conversations.join"
  read_path   = "/conversations.info?channel={id}"

  destroy_path   = "/api.test"
  destroy_method = "POST"

  update_path   = ""
  update_method = "POST"

  data = jsonencode({
    channel = restapi_object.ci_operations_channel.id
  })

  id_attribute              = "channel/id"
  ignore_all_server_changes = true

  depends_on = [restapi_object.ci_operations_channel]

  lifecycle {
    postcondition {
      condition     = self.api_response != null && try(jsondecode(self.api_response).ok, false) == true
      error_message = "Slack conversations.join failed for #ci-operations: ${try(jsondecode(self.api_response).error, "unknown")}"
    }
  }
}

resource "github_actions_variable" "terraform_apply_slack_channel" {
  repository    = "monitoring-monorepo"
  variable_name = "TERRAFORM_APPLY_SLACK_CHANNEL"
  value         = "#ci-operations"
}

output "ci_operations_channel_id" {
  description = "Slack channel ID for #ci-operations (used by Terraform apply-pending notifications)"
  value       = restapi_object.ci_operations_channel.id
}
