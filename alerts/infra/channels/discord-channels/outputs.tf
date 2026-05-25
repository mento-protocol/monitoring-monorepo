#####################
# Discord Channel Outputs
#####################

output "multisig_discord_channels" {
  description = "Discord channel names for multisig monitoring"
  value = {
    alerts_channel = discord_text_channel.multisig_alerts.name
    events_channel = discord_text_channel.multisig_events.name
  }
}

#####################
# Webhook URL Outputs
#####################

output "webhook_urls" {
  description = "Auto-generated Discord webhook URLs for multisig monitoring"
  value = {
    alerts = jsondecode(restapi_object.discord_webhook_alerts.api_response).url
    events = jsondecode(restapi_object.discord_webhook_events.api_response).url
  }
  sensitive = true
}

#####################
# Webhook Info Outputs
#####################

output "webhook_info" {
  description = "Discord webhook IDs and channel information for multisig monitoring"
  value = {
    alerts_webhook_id = restapi_object.discord_webhook_alerts.id
    events_webhook_id = restapi_object.discord_webhook_events.id
    alerts_channel    = discord_text_channel.multisig_alerts.name
    events_channel    = discord_text_channel.multisig_events.name
  }
}

