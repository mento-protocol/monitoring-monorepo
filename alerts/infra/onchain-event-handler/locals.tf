# Compute a hash of the source files to detect actual changes
# This is more reliable than using the zip's SHA256 which includes metadata
# Prepare environment variables dynamically from multisig notification routes
locals {
  # fileset() returns paths relative to path.module; filemd5() resolves against
  # the TF working dir. Prefix each entry with ${path.module}/ so the hash
  # actually reflects src/** changes (otherwise Cloud Function never redeploys
  # on code edits). Excludes mirror archive_file.excludes so a test-only edit
  # doesn't flip the hash and force an identical-zip redeploy.
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
  # Include multisig config and Slack routing in the hash so adding/removing a
  # Safe address or changing destination channels forces a full Cloud Function
  # redeploy with the new env vars. Without this, ignore_changes on
  # environment_variables (workaround for the Google provider sensitive-env-var
  # bug) would leave the running function with stale config indefinitely.
  multisig_config_hash     = md5(jsonencode(local.multisig_config_for_json))
  notification_config_hash = md5(jsonencode(local.shared_channel_ids))
  source_hash = md5(join("", concat(
    [
      for f in sort(concat(local.source_files, local.package_files)) :
      fileexists(f) ? filemd5(f) : ""
    ],
    [local.multisig_config_hash, local.notification_config_hash],
  )))

  # Extract non-sensitive values from multisig_notifications to avoid provider
  # bugs. The entire variable is marked sensitive because it includes routing
  # config that arrives alongside secrets.
  multisig_notifications_nonsensitive = nonsensitive(var.multisig_notifications)

  # Get shared Slack channel IDs (all multisigs use the same two channels).
  # Extract from first multisig since they're all the same.
  shared_channel_ids = length(local.multisig_notifications_nonsensitive) > 0 ? {
    alerts = local.multisig_notifications_nonsensitive[keys(local.multisig_notifications_nonsensitive)[0]].alerts_channel_id
    events = local.multisig_notifications_nonsensitive[keys(local.multisig_notifications_nonsensitive)[0]].events_channel_id
    } : {
    alerts = ""
    events = ""
  }

  # Flatten multisig configs into environment variables
  # Format: MULTISIG_{KEY}_ADDRESS, etc.
  # The `length(...) > 0 ? merge(...) : {}` guard handles the empty-config
  # case: `merge([]...)` is `merge()` (zero args), which Terraform errors on
  # before reaching the function precondition's friendly validation message.
  multisig_env_vars = length(local.multisig_notifications_nonsensitive) > 0 ? merge([
    for key, config in local.multisig_notifications_nonsensitive : {
      "MULTISIG_${upper(replace(key, "-", "_"))}_ADDRESS" = config.address
      "MULTISIG_${upper(replace(key, "-", "_"))}_NAME"    = config.name
      "MULTISIG_${upper(replace(key, "-", "_"))}_CHAIN"   = config.chain
    }
  ]...) : {}

  # Multisig config
  multisig_config_for_json = {
    for key, config in local.multisig_notifications_nonsensitive : key => {
      address = config.address
      name    = config.name
      chain   = config.chain
    }
  }

  # Get list of unique chains for logging
  chains = distinct([for k, v in local.multisig_notifications_nonsensitive : v.chain])

  # Combine with base environment variables (excluding secrets — the
  # QUICKNODE_SIGNING_SECRET + SLACK_BOT_TOKEN env vars are injected via
  # service_config.secret_environment_variables in main.tf, not here).
  all_env_vars = merge(
    {
      # JSON-encoded multisig config for easy lookup in the function
      MULTISIG_CONFIG          = jsonencode(local.multisig_config_for_json)
      QUICKNODE_REPLAY_BUCKET  = google_storage_bucket.webhook_replay_nonces.name
      FUNCTION_TIMEOUT_SECONDS = tostring(var.timeout_seconds)
      SLACK_CHANNEL_ALERTS     = local.shared_channel_ids.alerts
      SLACK_CHANNEL_EVENTS     = local.shared_channel_ids.events
      # Comma-separated list of supported chains
      SUPPORTED_CHAINS = join(",", local.chains)
    },
    local.multisig_env_vars
  )
}
