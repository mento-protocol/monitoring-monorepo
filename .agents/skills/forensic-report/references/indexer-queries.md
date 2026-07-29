---
title: Forensic Report — Mento Indexer Query Cookbook
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
doc_type: skill
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# Mento indexer query cookbook

Deep procedure for Step 1.6 of [`SKILL.md`](../SKILL.md). The production Envio
endpoint is the primary on-chain-behaviour source for the target chain: Arkham
and Nansen are blind on Celo and Monad, so this is where "what did this address
do with Mento" gets answered there.

## Hard constraints (read before writing a query)

From `docs/pr-checklists/swr-polling-hasura.md`:

- **1000-row cap** per response and **no `_aggregate`** on hosted Hasura. For
  lifetime totals, page with `offset`/`limit` or narrow with `where`, then **sum
  client-side**.
- When paging, `order_by` must end in a unique tiebreaker (`{ id: desc }`).
  Ordering by `blockTimestamp`/`timestamp` alone is non-deterministic when rows
  share a block, so plain offset pagination skips and duplicates rows.
- `volumeUsdWei` is 0 when neither leg is USD-pegged (non-stable FX pairs) —
  don't read that as "no volume".
- `BrokerSwapEvent` with `routedViaV3Router:true` are v3 siblings already
  counted in `SwapEvent` — filter them out (`_eq:false`) to avoid
  double-counting.
- `RebalanceEvent.notionalUsd`/`rewardUsd` use an **empty-string sentinel** when
  pre-reserve RPC failed — handle `""` distinctly from `"0"`.

## Endpoint and liveness probe

Coverage: Celo (`42220`), Monad (`143`), Polygon (`137`), Ethereum (`1`,
currently reserve-yield entities). Always verify the requested chain is live
before treating an empty result as evidence. Query this before the funder graph.

```bash
HASURA=https://indexer.hyperindex.xyz/2f3dd15/v1/graphql   # public, no key, POST application/json
# Sanity-check the deployment is serving before trusting any EMPTY result — parallel Envio
# deploys can prune an entry mid-serve, so a 404/empty endpoint is NOT a "no activity" finding:
# (a) Liveness: confirm the endpoint serves at all.
curl -s "$HASURA" -H 'content-type: application/json' \
  --data '{"query":"{ SwapEvent(limit:1){ id } }"}' | jq .
# (b) Chain coverage: probe a SPREAD of activity areas for $CHAIN_ID — swaps, LP, supply, rebalances, and
#     bridges — so a quiet/new chain whose activity is non-swap isn't mis-marked. (BridgeTransfer keys on
#     sourceChainId/destChainId, not chainId.)
curl -s "$HASURA" -H 'content-type: application/json' \
  --data "{\"query\":\"{ SwapEvent(where:{chainId:{_eq:$CHAIN_ID}},limit:1){id} LiquidityEvent(where:{chainId:{_eq:$CHAIN_ID}},limit:1){id} StableSupplyChangeEvent(where:{chainId:{_eq:$CHAIN_ID}},limit:1){id} RebalanceEvent(where:{chainId:{_eq:$CHAIN_ID}},limit:1){id} BridgeTransfer(where:{_or:[{sourceChainId:{_eq:$CHAIN_ID}},{destChainId:{_eq:$CHAIN_ID}}]},limit:1){id} SusdsPosition(where:{chainId:{_eq:$CHAIN_ID}},limit:1){id} SusdsYieldMovement(where:{chainId:{_eq:$CHAIN_ID}},limit:1){id} StethPosition(where:{chainId:{_eq:$CHAIN_ID}},limit:1){id} StethYieldMovement(where:{chainId:{_eq:$CHAIN_ID}},limit:1){id} }\"}" | jq .
# Ethereum reserve-yield coverage includes both sUSDS and stETH positions and
# movement history; omitting either family can turn real activity into false EMPTY.
# Mark the indexer NOT-COVERED for $CHAIN only if EVERY entity above (and the full battery below) is
# empty AND $CHAIN isn't in the indexer's configured network list — see the `networks:` section of
# `indexer-envio/config.multichain.mainnet.yaml`. Otherwise an empty result is EMPTY (a real signal).
```

## Picking the filter field

All fields verified against `indexer-envio/schema.graphql`. `caller` = `tx.from`
(the signing EOA — the volume-attribution primary key); `sender`/`brokerCaller`
= `msg.sender` to the pool/broker (often a router); `txTo` = entry-point
contract (identifies the aggregator router). All three are in each row, so you
disambiguate EOA-vs-router on the spot.

**Scope every query to the target chain.** Add `chainId: { _eq: <CHAIN_ID> }` to
the `where` of each entity that carries it (every swap/rollup/rebalance/LP
entity below does; `BridgeTransfer` and `BridgeBridger` do not). Without it, a
multi-chain address silently merges its Celo, Monad, and Polygon footprints and
misreports volume/activity. Drop the filter only when you deliberately want the
all-chain Mento footprint.

**Match the field to the target type.** `caller` is `tx.from` — correct for an
**EOA target**. For a **contract target** (router / aggregator / rebalancer /
the bot contract itself), `tx.from` is the _operator EOA_, not the contract, so a
`caller`-only filter returns a false-EMPTY even though the contract is all over
the data. Filter on `sender` / `txTo` / `recipient` / `brokerCaller` instead, or
`_in` across roles when the address could appear as either. The examples below
show `caller`; swap the field to match the target.

## The battery

```graphql
# Lifetime rollups (fast path — swap volume, cadence, routers, protocol-actor flag)
{
  TraderDailySnapshot(
    where: { trader: { _eq: "0xtarget" }, chainId: { _eq: <CHAIN_ID> } }
    order_by: { timestamp: desc }
    limit: 1000
  ) {
    chainId
    timestamp
    swapCount
    uniquePools
    volumeUsdWei
    feesPaidUsdWei
    aggregatorKeys
    isProtocolActor
  }
}
{
  BrokerTraderDailySnapshot(
    where: { caller: { _eq: "0xtarget" }, chainId: { _eq: <CHAIN_ID> } }
    order_by: { timestamp: desc }
    limit: 1000
  ) {
    chainId
    timestamp
    swapCount
    volumeUsdWei
    aggregatorKeys
    isProtocolActor
  }
} # v2 path, Celo only
# Raw per-swap detail (v3 pools + v2 broker)
{
  SwapEvent(
    where: { caller: { _eq: "0xtarget" }, chainId: { _eq: <CHAIN_ID> } }
    order_by: [{ blockTimestamp: desc }, { id: desc }] # id tiebreaker → deterministic offset pagination
    limit: 1000
  ) {
    txHash
    blockTimestamp
    chainId
    poolId
    caller
    sender
    recipient
    txTo
    amount0In
    amount1In
    amount0Out
    amount1Out
    volumeUsdWei
  }
}
{
  BrokerSwapEvent(
    where: { caller: { _eq: "0xtarget" }, chainId: { _eq: <CHAIN_ID> }, routedViaV3Router: { _eq: false } }
    order_by: [{ blockTimestamp: desc }, { id: desc }]
    limit: 1000
  ) {
    txHash
    blockTimestamp
    chainId
    caller
    brokerCaller
    txTo
    tokenIn
    tokenOut
    amountIn
    amountOut
    volumeUsdWei
    exchangeId
  }
}

# Role-specific: MEV keeper? CDP actor? LP? mint/burn? bridger?
{
  RebalanceEvent(where: { caller: { _eq: "0xtarget" }, chainId: { _eq: <CHAIN_ID> } }, order_by: [{ blockTimestamp: desc }, { id: desc }], limit: 1000) {
    txHash
    poolId
    sender
    caller
    notionalUsd
    rewardUsd
    effectivenessRatio
  }
}
{
  Trove(where: { owner: { _eq: "0xtarget" }, chainId: { _eq: <CHAIN_ID> } }) {
    id
    coll
    debt
    status
  }
}
{
  # CDP operation HISTORY (open/adjust/close), not just currently-owned troves — a target that opened then
  # closed owns no Trove now but is all over TroveOperationEvent. NOTE: the indexer records LIQUIDATE in a
  # separate LiquidationEvent (keyed by trove/instance, not owner address), so liquidations are NOT in this
  # entity — check LiquidationEvent by troveId if the target's trove may have been liquidated.
  TroveOperationEvent(where: { owner: { _eq: "0xtarget" }, chainId: { _eq: <CHAIN_ID> } }, order_by: [{ timestamp: desc }, { id: desc }], limit: 1000) {
    id
    troveId
    operation
    collChange
    debtChange
  }
}
{
  LiquidityPosition(where: { address: { _eq: "0xtarget" }, chainId: { _eq: <CHAIN_ID> } }) {
    poolId
  }
}
{
  # sUSDS current position (Ethereum-only in this indexer).
  SusdsPosition(where: { wallet: { _eq: "0xtarget" }, chainId: { _eq: <CHAIN_ID> } }) {
    id
  }
}
{
  SusdsYieldMovement(
    where: { _and: [{ _or: [{ from: { _eq: "0xtarget" } }, { to: { _eq: "0xtarget" } }] }, { chainId: { _eq: <CHAIN_ID> } }] }
    order_by: [{ blockNumber: desc }, { id: desc }]
    limit: 1000
  ) {
    id
    txHash
  }
}
{
  # stETH current position plus historical movements (Ethereum-only).
  StethPosition(where: { wallet: { _eq: "0xtarget" }, chainId: { _eq: <CHAIN_ID> } }) {
    id
  }
}
{
  StethYieldMovement(
    where: { _and: [{ _or: [{ from: { _eq: "0xtarget" } }, { to: { _eq: "0xtarget" } }] }, { chainId: { _eq: <CHAIN_ID> } }] }
    order_by: [{ blockNumber: desc }, { id: desc }]
    limit: 1000
  ) {
    id
    txHash
  }
}
{
  # Filter on caller (signer) OR counterparty (mint recipient / burn holder) — the target may be the
  # recipient/holder rather than the tx signer, which a caller-only filter would miss.
  StableSupplyChangeEvent(where: { _and: [{ _or: [{ caller: { _eq: "0xtarget" } }, { counterparty: { _eq: "0xtarget" } }] }, { chainId: { _eq: <CHAIN_ID> } }] }, limit: 1000) {
    txHash
    kind
    amount
  }
}
{
  # BridgeBridger is a cross-chain identity aggregate keyed by sender (sourceChainsUsed is a
  # JSON array) — it has NO chainId field, so do not add a chainId filter here.
  BridgeBridger(where: { sender: { _eq: "0xtarget" } }) {
    id
  }
}
{
  # BridgeTransfer carries sourceChainId/destChainId (not chainId). Scope to the target chain via either
  # endpoint AND keep the sender/recipient role predicate; drop the chain clause only for the all-chain view.
  BridgeTransfer(
    where: {
      _and: [
        { _or: [{ sender: { _eq: "0xtarget" } }, { recipient: { _eq: "0xtarget" } }] }
        { _or: [{ sourceChainId: { _eq: <CHAIN_ID> } }, { destChainId: { _eq: <CHAIN_ID> } }] }
      ]
    }
    limit: 1000
  ) {
    sentTxHash
    sender
    recipient
    amount
  }
}
```

A non-empty result here, scoped to the actual target chain, is far stronger than
anything the Celo-blind attributors can give — and a verified-live **empty**
result is a real signal ("never interacted with Mento v2/v3 on this chain"), not
a tooling gap.
