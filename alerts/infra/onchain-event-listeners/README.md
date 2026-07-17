<!-- agent-context: title="On-chain Event Listeners Module" status=active owner=eng canonical=true last_verified=2026-07-17 doc_type=runbook scope=alerts/infra/onchain-event-listeners review_interval_days=90 garden_lane=operator-runbooks -->

# On-chain Event Listeners Module

Terraform module for creating one QuickNode `evmContractEvents` webhook per
configured chain. Each webhook filters Safe logs by contract address and the 17
topic hashes committed in `event-hashes.json`, then sends signed payloads to the
shared on-chain event handler.

The parent `alerts/infra` stack currently configures Celo and Ethereum. The
handler routes eight security events to `#multisig-alerts` and the remaining
nine operational events to `#multisig-events`.

## Source of truth

- `../onchain-event-handler/src/safe-abi.json` is the Safe event ABI.
- `event-hashes.json` is the Terraform input generated from that ABI.
- `../onchain-event-handler/src/constants.ts` computes the same hashes at
  runtime and defines the security-event subset.

Regenerate and validate the committed hashes after changing the ABI:

```bash
pnpm --filter @mento-protocol/alerts-onchain-event-handler build:event-hashes
```

## Usage

The root stack owns module instantiation. Its current shape is:

```hcl
module "onchain_event_listeners" {
  source   = "./onchain-event-listeners"
  for_each = local.multisigs_by_chain

  providers = {
    restapi.quicknode = restapi.quicknode
  }

  chain_key               = each.key
  webhook_endpoint_url     = module.onchain_event_handler.function_url
  multisig_addresses       = [for _, multisig in each.value : multisig.address]
  webhook_name             = "safe-multisig-monitor-${each.key}"
  quicknode_network_name   = local.multisigs_by_chain_network[each.key]
  quicknode_api_key        = var.quicknode_api_key
  quicknode_signing_secret = var.quicknode_signing_secret
  debug_mode               = var.debug_mode
}
```

Do not instantiate this module independently. The parent stack validates that
all multisigs grouped under a chain use the same QuickNode network and wires the
handler URL and signing secret consistently.

## Inputs

| Name                       | Description                                                    | Default                 |
| -------------------------- | -------------------------------------------------------------- | ----------------------- |
| `chain_key`                | Lowercase parent `for_each` key used to scope state operations | required                |
| `webhook_endpoint_url`     | HTTPS on-chain event handler URL                               | required                |
| `multisig_addresses`       | Safe addresses monitored by this chain's webhook               | required                |
| `quicknode_api_key`        | QuickNode API key used by Terraform and the repair helper      | required                |
| `quicknode_signing_secret` | At least 32 characters; sent as the webhook security token     | required                |
| `webhook_name`             | Base name; a config hash is appended during creation           | `safe-multisig-monitor` |
| `quicknode_network_name`   | QuickNode network identifier                                   | `celo-mainnet`          |
| `compression`              | Destination payload compression (`none` or `gzip`)             | `none`                  |
| `debug_mode`               | REST provider request/response logging                         | `false`                 |

The module has no `is_active` input. Pause or resume a webhook in the QuickNode
dashboard only as an explicitly coordinated incident action; reconcile any
resulting drift before the next apply.

## Outputs

- `webhook_id`
- `webhook_endpoint`
- `webhook_name`

## Update and state behavior

QuickNode does not support in-place updates for this webhook shape. The module:

1. hashes the network, addresses, endpoint, signing secret, compression, and
   event hashes;
2. pauses and deletes the old webhook when that hash changes;
3. removes only the matching chain instance from Terraform state; and
4. creates a replacement through the `evmContractEvents` template.

`update_path` and `update_method` are deliberately absent. Do not add them: the
REST provider would attempt unsupported PUT/PATCH operations.

If a webhook was deleted outside Terraform and planning reports a 404, stop
before applying. After explicit state-repair approval, run
`alerts/infra/scripts/fix-webhook-state.sh`, inspect its proposed state changes,
then run `pnpm alerts:infra:plan` again. Deployment and recreation happen only
through the reviewed `production-infra`-gated CI workflow.

## Debugging and security

Keep `debug_mode = false` in CI. REST provider debug output contains the full
QuickNode `x-api-key` header and webhook signing secret. Never share a plan or
log captured with debug mode enabled.

The Cloud Function independently verifies the QuickNode HMAC signature, checks
the timestamp replay window, validates the configured chain/address pair, and
routes a failure for one event without aborting the rest of the batch.
