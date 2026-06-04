#####################
# Multisig Monitoring Outputs
#####################

output "monitored_multisigs" {
  description = "Details of all monitored multisigs across all chains"
  value = {
    for key, multisig in var.multisigs : key => {
      name    = multisig.name
      address = multisig.address
      chain   = multisig.chain
    }
  }
}

output "slack_channels" {
  description = "Slack channel names for on-chain event monitoring"
  value       = module.slack_channels.channel_names
}

#####################
# GCP Project Outputs
#####################

output "google_cloud" {
  description = "Google Cloud project details"
  value = {
    project_id          = local.project_id
    project_number      = module.project_factory.project_number
    project_name        = module.project_factory.project_name
    cloud_function_logs = "https://console.cloud.google.com/run/detail/${module.onchain_event_handler.function_location}/${module.onchain_event_handler.function_name}/observability/logs?project=${local.project_id}"
    cloud_function_url  = module.onchain_event_handler.function_url
  }
}

output "oncall_announcer" {
  description = "Splunk On-Call to Slack rotation announcer resources"
  value = {
    enabled               = local.oncall_announcer_enabled
    function_logs         = local.oncall_announcer_enabled ? "https://console.cloud.google.com/run/detail/${module.oncall_announcer[0].function_location}/${module.oncall_announcer[0].function_name}/observability/logs?project=${local.project_id}" : null
    function_name         = local.oncall_announcer_enabled ? module.oncall_announcer[0].function_name : null
    function_url          = local.oncall_announcer_enabled ? module.oncall_announcer[0].function_url : null
    scheduler_job_name    = local.oncall_announcer_enabled ? module.oncall_announcer[0].scheduler_job_name : null
    slack_channel_id      = local.oncall_slack_channel_id
    support_usergroup_id  = local.support_engineer_usergroup_id
    rotation_state_bucket = local.oncall_announcer_enabled ? module.oncall_announcer[0].rotation_state_bucket : null
  }
}

#####################
# QuickNode & Cloud Function Outputs
#####################

# Note: quicknode_webhook_ids is also available in monitoring_summary.quicknode.webhooks_by_chain
# Kept as top-level output for convenience
output "quicknode_webhooks" {
  description = "QuickNode webhook dashboard URLs by chain"
  value       = { for chain, module_output in module.onchain_event_listeners : chain => "https://dashboard.quicknode.com/webhooks/${module_output.webhook_id}" }
}

#####################
# Sentry Module Outputs
#####################

output "sentry_slack_channels" {
  description = "Slack channel names for Sentry alerts by project"
  value       = module.sentry_bridge.slack_channels
}
