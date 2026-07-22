<!-- agent-context: title="On-chain Event Listeners Module" status=active owner=eng canonical=true last_verified=2026-07-22 doc_type=runbook scope=alerts/infra/onchain-event-listeners review_interval_days=90 garden_lane=operator-runbooks -->

# On-chain Event Listeners Module

Terraform module for creating one QuickNode `evmContractEvents` webhook per
configured chain. Each webhook filters Safe logs by contract address and the 17
topic hashes committed in `event-hashes.json`, then sends signed payloads to the
shared on-chain event handler.

The parent `alerts/infra` stack currently configures Celo, Ethereum, and Polygon. The
handler routes eight security events to `#multisig-alerts` and the remaining
nine operational events to `#multisig-events`.

## Source of truth

- `../onchain-event-handler/src/safe-abi.json` is the Safe event ABI.
- `event-hashes.json` is the Terraform input generated from that ABI.
- `../onchain-event-handler/src/constants.ts` computes the same hashes at
  runtime and defines the security-event subset.

Regenerate the committed hashes after changing the ABI:

```bash
pnpm --filter @mento-protocol/alerts-onchain-event-handler build:event-hashes
```

The command overwrites `event-hashes.json`. When the ABI is not meant to
change, verify the result with
`git diff --exit-code -- alerts/infra/onchain-event-listeners/event-hashes.json`.
For an intentional ABI change, review and commit the regenerated file.

## Ownership and configuration

The parent [`alerts/infra`](../README.md) stack owns module instantiation. Its
current wiring is in [`../main.tf`](../main.tf), while
[`variables.tf`](variables.tf) and [`outputs.tf`](outputs.tf) are the maintained
input and output contracts. Do not instantiate this module independently: the
parent validates that all multisigs grouped under a chain use the same
QuickNode network and wires the handler URL and signing secret consistently.

The module has no `is_active` input. Pause or resume a webhook in the QuickNode
dashboard only as an explicitly coordinated incident action; reconcile any
resulting drift before the next apply.

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
`(cd alerts/infra && ./scripts/fix-webhook-state.sh)`, inspect its proposed state
changes, then run `pnpm alerts:infra:plan` again from the repository root.
For state-only recovery, dispatch `.github/workflows/alerts-infra.yml` from
`main`, review its authoritative plan, and approve the `production-infra`
environment. If the owning configuration also needs correction, use a reviewed
PR and its merge-triggered apply instead. The repair tool ignores
provider-rendered nested IDs and refuses all state changes when a QuickNode read
is rate-limited, unavailable, or otherwise inconclusive.

To roll back a listener change, revert the owning configuration, inspect
`pnpm alerts:infra:plan`, and let the protected main-branch workflow replace
the webhook. Never recreate, pause, or delete a webhook manually as a rollback.

## Debugging and security

Keep `debug_mode = false` in CI. REST provider debug output contains the full
QuickNode `x-api-key` header and webhook signing secret. Never share a plan or
log captured with debug mode enabled.

The Cloud Function independently verifies the QuickNode HMAC signature, checks
the timestamp replay window, validates the configured chain/address pair, and
routes a failure for one event without aborting the rest of the batch.
