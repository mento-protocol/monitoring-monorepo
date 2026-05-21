# On-Chain Event Listeners Module

This module creates and manages QuickNode webhooks for monitoring on-chain events from any smart contract. Currently configured for Safe multisig events, but extensible to monitor other contract types.

## Features

- Automated webhook creation via Terraform
- Server-side event filtering (JavaScript filter on QuickNode)
- Event signatures from Safe contract ABI (`safe-abi.json`)
- Multi-address support (multiple multisigs per webhook)

## What Gets Created

One QuickNode webhook per chain that monitors all specified multisig addresses and 16 Safe event types (filtered server-side).

## Event Types Monitored

### Security Events (→ Alerts Channel)

- `SafeSetup` - Initial Safe configuration
- `AddedOwner` - New owner added
- `RemovedOwner` - Owner removed
- `ChangedThreshold` - Signature threshold changed
- `ChangedFallbackHandler` - Fallback handler updated
- `EnabledModule` - Module enabled
- `DisabledModule` - Module disabled
- `ChangedGuard` - Transaction guard changed

### Operational Events (→ Events Channel)

- `ExecutionSuccess` - Transaction executed successfully
- `ExecutionFailure` - Transaction execution failed
- `ApproveHash` - Hash approved by owner
- `SignMsg` - Message signed
- `SafeModuleTransaction` - Transaction from module
- `ExecutionFromModuleSuccess` - Module transaction succeeded
- `SafeReceived` - Funds received
- `SafeMultiSigTransaction` - Multi-sig transaction executed

## Usage

```hcl
module "onchain_event_listeners" {
  source = "./onchain-event-listeners"

  providers = {
    restapi.quicknode = restapi.quicknode
  }

  webhook_endpoint_url   = "https://your-cloud-function-url.run.app"
  multisig_addresses     = [
    "0x655133d8E90F8190ed5c1F0f3710F602800C0150",  # Mento Labs
    "0x87647780180B8f55980C7D3fFeFe08a9B29e9aE1",  # Reserve
  ]
  webhook_name           = "safe-multisig-monitor"
  quicknode_network_name = "celo-mainnet"
  is_active              = true
}
```

## Inputs

| Name                     | Description                                         | Type           | Default                   | Required |
| ------------------------ | --------------------------------------------------- | -------------- | ------------------------- | -------- |
| `webhook_endpoint_url`   | URL of the Cloud Function endpoint                  | `string`       | -                         | Yes      |
| `multisig_addresses`     | List of Safe multisig addresses to monitor          | `list(string)` | -                         | Yes      |
| `webhook_name`           | Name for the QuickNode webhook                      | `string`       | `"safe-multisig-monitor"` | No       |
| `quicknode_network_name` | QuickNode network identifier (e.g., "celo-mainnet") | `string`       | `"celo-mainnet"`          | No       |
| `is_active`              | Whether the webhook should be active                | `bool`         | `true`                    | No       |
| `compression`            | Compression method for payloads                     | `string`       | `"none"`                  | No       |

## Outputs

| Name           | Description            |
| -------------- | ---------------------- |
| `webhook_id`   | QuickNode webhook ID   |
| `webhook_name` | QuickNode webhook name |

## Provider Requirements

### REST API Provider (QuickNode API)

```hcl
provider "restapi" {
  alias = "quicknode"
  uri   = "https://api.quicknode.com"
  headers = {
    "x-api-key"    = var.quicknode_api_key
    "Content-Type" = "application/json"
    "accept"       = "application/json"
  }
  write_returns_object = true
}
```

**Required:**

- QuickNode API key from: [dashboard.quicknode.com/api-keys](https://dashboard.quicknode.com/api-keys)

## Architecture

```text
QuickNode (Celo Mainnet)
    ↓
Filter Function (JavaScript)
    ↓ (only matching events)
Cloud Function Endpoint
    ↓
Process & Route to Discord
```

## Filter Function

The module includes a sophisticated JavaScript filter function that runs on QuickNode's servers:

```javascript
function main(payload) {
  // Validates payload structure
  // Filters by multisig address
  // Filters by event signature (topic0)
  // Returns only matching events
}
```

**Benefits:** Reduces webhook calls and Cloud Function invocations (cost optimization), fast server-side filtering, robust error handling.

## Event Signatures

Event signatures are automatically extracted from the Safe contract ABI (`safe-abi.json` at the repository root):

```json
{
  "security_events": {
    "0x9465fa0c962cc76958e6373a993326400c1c94f8be2fe3a952adfa7f60b2ea26": "AddedOwner",
    ...
  },
  "operational_events": {
    "0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e": "ExecutionSuccess",
    ...
  }
}
```

This ensures consistency between Terraform and the TypeScript Cloud Function.

## Network Support

Currently supports:

- `celo-mainnet` (default)
- `celo-testnet`

To add support for other networks, update the `network` variable.

## Webhook Management

### Activate/Deactivate

```hcl
is_active = false  # Pause webhook without deleting
```

### Delete Webhook

Remove the module or run:

```bash
terraform destroy -target=module.onchain_event_listeners
```

### Update Filter or Configuration

**IMPORTANT:** QuickNode webhooks cannot be updated via PUT/PATCH. When webhook configuration changes (filter function, addresses, etc.), Terraform will recreate the webhook.

**If you get a 404 error during apply:**

This happens because Terraform plans an update before the provisioner can delete the old webhook. To fix:

```bash
# Remove the webhook from Terraform state
terraform state rm 'module.onchain_event_listeners["celo"].restapi_object.multisig_webhook'

# Apply again - it will create a new webhook
terraform apply
```

The provisioner will automatically delete the old webhook from QuickNode, but you need to remove it from Terraform state first.

### Update Filter

Event signatures are automatically updated when `safe-abi.json` changes.

## Cost Optimization

Server-side filtering minimizes costs:

- QuickNode: Only charged for matching events
- Cloud Functions: Fewer invocations
- Estimated savings: ~80% vs server-side-only filtering

## State Management

### Overview

QuickNode webhooks require special handling because they **cannot be updated via PUT/PATCH**. Any configuration change requires deleting and recreating the webhook. This can cause state drift issues.

**📚 See [WEBHOOK_STATE_MANAGEMENT.md](./WEBHOOK_STATE_MANAGEMENT.md) for comprehensive documentation.**

### Common Issue: 404 Errors on Apply

**Symptom:** `Error: unexpected response code '404'` when running `terraform apply`

**Cause:** Webhook in Terraform state doesn't exist in QuickNode (deleted manually or by a previous failed apply)

**Quick Fix:**

```bash
# Option 1: Manual fix (always works, no network required)
terraform state rm -lock=false 'module.onchain_event_listeners["<network>"].restapi_object.multisig_webhook'
terraform state rm -lock=false \
  'module.onchain_event_listeners["<network>"].null_resource.pause_webhook_before_update' \
  'module.onchain_event_listeners["<network>"].null_resource.pause_webhook_on_destroy'
terraform plan -lock=false
terraform apply -lock=false

# Option 2: Automated fix (requires network access)
./scripts/fix-webhook-state.sh
terraform apply -lock=false
```

Replace `<network>` with your network key (e.g., `celo`, `ethereum`, `base`).

### State Repair Script

Use [`scripts/fix-webhook-state.sh`](../scripts/fix-webhook-state.sh) to automatically detect and fix state drift:

```bash
# Run the repair script (automatically reads API key from terraform.tfvars)
./scripts/fix-webhook-state.sh

# The script will:
# 1. Read QuickNode API key from terraform.tfvars (or QUICKNODE_API_KEY env var)
# 2. Check which webhooks exist in Terraform state
# 3. Verify they exist in QuickNode
# 4. Identify orphaned webhooks
# 5. Offer to remove them from state
# 6. Guide you through terraform apply
```

### Best Practices for State Management

1. **Before applying changes**, run the state repair script
2. **After manual changes** in QuickNode dashboard, refresh state
3. **Use version control** for Terraform state (or remote backend)
4. **Coordinate with team** when applying changes

### Why This Approach?

The module uses several techniques to prevent state drift:

- **Hash-based naming** - Webhook names include a config hash to force recreation on changes
- **No update operations** - `update_method = "POST"` prevents PUT/PATCH attempts
- **Automated cleanup** - Provisioners pause and delete old webhooks before recreation
- **Debug mode** - Enabled by default for better troubleshooting

See [WEBHOOK_STATE_MANAGEMENT.md](./WEBHOOK_STATE_MANAGEMENT.md) for architecture details and advanced troubleshooting.

## Troubleshooting

### Webhook Not Creating

**Error:** `Error creating QuickNode webhook`

**Causes:**

- Invalid API key
- Invalid network identifier
- Malformed filter function

**Solution:**

1. Verify API key: <https://dashboard.quicknode.com/api-keys>
2. Check network: `celo-mainnet` or `celo-testnet`
3. Enable debug mode: `debug_mode = true`

### No Events Received

**Causes:**

- Webhook is paused (`is_active = false`)
- No matching events on blockchain
- Filter function blocking all events
- Cloud Function endpoint is down

**Solution:**

1. Check webhook status in QuickNode dashboard
2. Verify multisig addresses are correct
3. Test Cloud Function endpoint manually
4. Check Cloud Function logs

### Filter Function Errors

**Error:** `Filter function returned null for all events`

**Solution:**

- Check that addresses are correct (lowercase)
- Verify event signatures are up to date
- Review QuickNode webhook logs

## Best Practices

1. **Test First** - Use `celo-testnet` before mainnet
2. **Monitor Logs** - Check QuickNode webhook delivery status
3. **Signature Validation** - Always verify webhook signatures in Cloud Function
4. **Error Handling** - Filter function includes comprehensive error handling
5. **Version Control** - Track changes to event signatures

## Integration with Cloud Function

This module works in tandem with the [`onchain-event-handler`](../onchain-event-handler/README.md):

```hcl
# 1. Deploy Cloud Function
module "alert_handler" { ... }

# 2. Create QuickNode webhook pointing to Cloud Function
module "onchain_event_listeners" {
  source = "./onchain-event-listeners"
  webhook_endpoint_url = module.alert_handler.function_url
  depends_on           = [module.alert_handler]
}
```

## Security

- Signature verification (HMAC-SHA256)
- HTTPS-only endpoints
- Address format validation
- Error containment (errors don't crash webhook)

## Performance

- Latency: ~2-3 seconds from blockchain event to Discord notification
- Throughput: Handles multiple events per block
- Reliability: Filter function prevents webhook failures

## Related Modules

- [`discord-channel-manager`](../discord-channel-manager/README.md) - Creates Discord channels and webhooks
- [`onchain-event-handler`](../onchain-event-handler/README.md) - Processes webhooks
- [`sentry-alerts`](../sentry-alerts/README.md) - Application error monitoring

## References

- [QuickNode Webhooks Documentation](https://www.quicknode.com/docs/webhooks)
- [QuickNode REST API](https://www.quicknode.com/docs/webhooks) (see webhooks section)
- [Safe Contracts Documentation](https://docs.safe.global/)
- Event signatures are automatically extracted from the Safe contract ABI (`../safe-abi.json`)
