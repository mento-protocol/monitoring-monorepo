# Compute a hash of the source files to detect actual changes
# This is more reliable than using the zip's SHA256 which includes metadata
# Prepare environment variables dynamically from multisig webhooks
locals {
  # Source file hashing for stable deployments
  source_files = fileset(path.module, "src/**")
  package_files = [
    "${path.module}/package.json",
    "${path.module}/package-lock.json",
    "${path.module}/tsconfig.json",
    "${path.root}/safe-abi.json",
  ]
  # Create a hash of all source files and package files
  source_hash = md5(join("", [
    for f in sort(concat(tolist(local.source_files), local.package_files)) :
    fileexists(f) ? filemd5(f) : ""
  ]))

  # Extract non-sensitive values from multisig_webhooks to avoid provider bug
  # The entire var.multisig_webhooks is marked sensitive, so we extract values first
  multisig_webhooks_nonsensitive = nonsensitive(var.multisig_webhooks)

  # Get shared webhook URLs (all multisigs use the same webhooks)
  # Extract from first multisig since they're all the same
  shared_webhook_urls = length(local.multisig_webhooks_nonsensitive) > 0 ? {
    alerts = local.multisig_webhooks_nonsensitive[keys(local.multisig_webhooks_nonsensitive)[0]].alerts_webhook
    events = local.multisig_webhooks_nonsensitive[keys(local.multisig_webhooks_nonsensitive)[0]].events_webhook
    } : {
    alerts = ""
    events = ""
  }

  # Flatten multisig configs into environment variables
  # Format: MULTISIG_{KEY}_ADDRESS, etc.
  multisig_env_vars = merge([
    for key, config in local.multisig_webhooks_nonsensitive : {
      "MULTISIG_${upper(replace(key, "-", "_"))}_ADDRESS" = config.address
      "MULTISIG_${upper(replace(key, "-", "_"))}_NAME"    = config.name
      "MULTISIG_${upper(replace(key, "-", "_"))}_CHAIN"   = config.chain
    }
  ]...)

  # Multisig config
  multisig_config_for_json = {
    for key, config in local.multisig_webhooks_nonsensitive : key => {
      address = config.address
      name    = config.name
      chain   = config.chain
    }
  }

  # Get list of unique chains for logging
  chains = distinct([for k, v in local.multisig_webhooks_nonsensitive : v.chain])

  # Combine with base environment variables (excluding secret)
  all_env_vars = merge(
    {
      # JSON-encoded multisig config for easy lookup in the function
      MULTISIG_CONFIG = jsonencode(local.multisig_config_for_json)
      # Comma-separated list of supported chains
      SUPPORTED_CHAINS = join(",", local.chains)
      # Shared webhook URLs (all multisigs use the same webhooks)
      DISCORD_WEBHOOK_ALERTS = local.shared_webhook_urls.alerts
      DISCORD_WEBHOOK_EVENTS = local.shared_webhook_urls.events
    },
    local.multisig_env_vars
  )
}

