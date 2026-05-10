# Monad RPC Archive Depth Check

Date: 2026-05-10

## Summary

The current indexer fallback policy should continue to treat QuickNode Monad as
unsafe for historical catch-up `eth_call`s. Public QuickNode docs now label
Monad Mainnet as `Archive: Yes`, but the same table lists pruning as only
`Over 40,000 recent blocks available`, which is not enough for a full
historical re-sync from the configured start block.

## Findings

- QuickNode Monad docs list Mainnet chain ID `143`, `Archive: Yes`, and
  `Pruning: Over 40,000 recent blocks available`.
  Source: <https://www.quicknode.com/docs/monad/api-overview>
- QuickNode's general pruning-policy table says Monad Mainnet is archive
  enabled but pruned to `Over 40,000 recent blocks available`.
  Source: <https://www.quicknode.com/docs/platform/supported-chains-node-types>
- Monad's JSON-RPC docs publish provider-level `eth_call` gas limits and
  `eth_getLogs` block-range limits, but do not publish request-rate limits.
  Source: <https://monad.docsbot.app/reference/>
- dRPC publicly documents Monad support, but the public docs found in this
  pass do not state Monad archive retention depth.
  Source: <https://drpc.org/blog/drpc-adds-support-for-monad-rpc/>

## Operational Decision

Keep `rpc2.monad.xyz` / the deep-archive endpoint as the only provider allowed
for historical Monad catch-up reads. QuickNode can remain a high-rate fallback
for recent blocks under the existing block-depth-aware dispatcher, but it
should not be promoted to a catch-up-capable archive provider based on the
current public documentation.

## Still External

Opening a QuickNode support ticket is still useful, but it cannot be completed
from this repo. The concrete ask should be:

> Can this Monad Mainnet endpoint be upgraded to full historical archive state
> for `eth_call` at arbitrary historical blocks, beyond the documented
> "Over 40,000 recent blocks available" retention window?
