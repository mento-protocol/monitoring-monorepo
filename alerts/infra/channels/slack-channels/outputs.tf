output "channel_ids" {
  description = "Slack channel IDs keyed by logical route."
  value = {
    for key, channel in restapi_object.channel : key => channel.id
  }
}

output "channel_names" {
  description = "Slack channel names keyed by logical route."
  value = {
    for key, channel in var.channels : key => channel.name
  }
}
