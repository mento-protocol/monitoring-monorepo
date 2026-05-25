locals {
  # Event topic hashes — keccak256 of each Safe event signature. QuickNode's
  # `evmContractEvents` template fires when a log's topic0 matches any of
  # these from any of the configured `contracts` addresses, then ABI-decodes
  # the payload and delivers it as `{result: [...]}`.
  #
  # Regenerate by running:
  #   pnpm --filter @mento-protocol/alerts-onchain-event-handler build:event-hashes
  # The handler computes the same set at runtime in `constants.ts` from the
  # same safe-abi.json — both paths stay in lock-step.
  event_hashes = [for e in jsondecode(file("${path.module}/event-hashes.json")) : e.hash]

  # Normalize the webhook URL to a stable string value for comparison
  # This ensures Terraform compares the actual URL string, not the resource reference
  # When the function is replaced but URL doesn't change, this prevents unnecessary webhook recreation
  webhook_url_normalized = trim(var.webhook_endpoint_url, " \t\n\r")

  # Create a hash of the webhook data to detect changes (excluding status).
  # Triggers the pause resource before updates. destination_url is normalized
  # so a Cloud Function recreation that ends up at the same URL doesn't
  # cause unnecessary webhook rotation.
  webhook_data_hash = md5(jsonencode({
    name            = var.webhook_name
    network         = var.quicknode_network_name
    contracts       = [for addr in var.multisig_addresses : lower(addr)]
    event_hashes    = local.event_hashes
    destination_url = local.webhook_url_normalized
    security_token  = var.quicknode_signing_secret
    compression     = var.compression
  }))
}

