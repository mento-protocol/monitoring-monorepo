locals {
  source_files_relative = [
    for f in fileset(path.module, "src/**") :
    f if !can(regex("\\.test\\.(ts|js)$", f))
  ]
  source_files = [for f in local.source_files_relative : "${path.module}/${f}"]
  package_files = [
    "${path.module}/package.json",
    "${path.module}/pnpm-lock.yaml",
    "${path.module}/pnpm-workspace.yaml",
    "${path.module}/tsconfig.json",
  ]
  runtime_config_hash = md5(jsonencode({
    announce_on_first_run                 = var.announce_on_first_run
    schedule                              = var.schedule
    slack_channel_id                      = var.slack_channel_id
    slack_support_usergroup_id            = var.slack_support_usergroup_id
    splunk_on_call_api_base_url           = var.splunk_on_call_api_base_url
    splunk_on_call_escalation_policy_slug = var.splunk_on_call_escalation_policy_slug
    splunk_on_call_team_slug              = var.splunk_on_call_team_slug
  }))
  source_hash = md5(join("", concat(
    [
      for f in sort(concat(local.source_files, local.package_files)) :
      fileexists(f) ? filemd5(f) : ""
    ],
    [local.runtime_config_hash],
  )))

  all_env_vars = {
    ANNOUNCE_ON_FIRST_RUN                 = tostring(var.announce_on_first_run)
    ONCALL_STATE_BUCKET                   = google_storage_bucket.rotation_state.name
    ONCALL_STATE_OBJECT                   = "current-oncall.json"
    SLACK_CHANNEL_ID                      = var.slack_channel_id
    SLACK_SUPPORT_USERGROUP_ID            = var.slack_support_usergroup_id
    SPLUNK_ON_CALL_API_BASE_URL           = var.splunk_on_call_api_base_url
    SPLUNK_ON_CALL_ESCALATION_POLICY_SLUG = var.splunk_on_call_escalation_policy_slug
    SPLUNK_ON_CALL_TEAM_SLUG              = var.splunk_on_call_team_slug
  }
}
