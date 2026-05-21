# Load event signatures from shared JSON file (single source of truth)
# This ensures consistency between Terraform and TypeScript code
locals {
  # Generate JavaScript filter function for QuickNode webhook
  # The filter function checks if logs match any of our multisig addresses
  # and any of our event signatures (topic0)
  # Includes error handling to prevent webhook failures
  # Load ABI from shared JSON file at root (single source of truth)
  safe_abi = jsondecode(file("${path.root}/safe-abi.json"))

  # Generate ABI comment block for QuickNode template metadata
  # Format: /*\ntemplate: evmAbiFilter\nabi: [<JSON>]\ncontracts: <addresses>\n*/
  abi_comment = <<-EOT
/*
template: evmAbiFilter
abi: ${jsonencode(local.safe_abi)}
contracts: ${join(", ", [for addr in var.multisig_addresses : lower(addr)])}
*/
EOT

  # Load from template file and inject multisig addresses and ABI from Terraform config
  filter_function_js = templatefile("${path.module}/filter-function.js.tpl", {
    contracts   = var.multisig_addresses
    abi         = local.safe_abi
    abi_comment = local.abi_comment
  })

  # Base64 encode the filter function
  filter_function_base64 = base64encode(local.filter_function_js)

  # Normalize the webhook URL to a stable string value for comparison
  # This ensures Terraform compares the actual URL string, not the resource reference
  # When the function is replaced but URL doesn't change, this prevents unnecessary webhook recreation
  webhook_url_normalized = trim(var.webhook_endpoint_url, " \t\n\r")

  # Create a hash of the webhook data to detect changes (excluding status)
  # This will trigger the pause resource before updates
  # Note: destination_url is normalized to compare actual string value, not resource reference
  webhook_data_hash = md5(jsonencode({
    name            = var.webhook_name
    network         = var.quicknode_network_name
    filter_function = local.filter_function_base64
    destination_url = local.webhook_url_normalized
    security_token  = var.quicknode_signing_secret
    compression     = var.compression
  }))
}

