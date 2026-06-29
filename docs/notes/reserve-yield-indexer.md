---
title: Reserve-Yield Indexer Topology
status: active
owner: eng
canonical: true
last_verified: 2026-06-29
---

# Reserve-Yield Indexer Topology

Reserve-yield actuals are isolated from the production Celo + Monad indexer.
The primary hosted `mento` project continues to use
`indexer-envio/config.multichain.mainnet.yaml` and must not include Ethereum
chain 1 contracts.

The Ethereum reserve-yield config is:

```bash
pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:codegen
pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:dev
pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test
```

It uses `indexer-envio/config.reserve-yield.mainnet.yaml` and
`indexer-envio/src/EventHandlersReserveYield.ts`.

## Invariants

- The Celo + Monad production indexer has no Ethereum chain dependency.
- The reserve-yield entry point registers sparse sUSDS/stETH token events only.
- The reserve-yield entry point does not register the historical sUSDS
  `onBlock` heartbeat.
- sUSDS event handlers write movement rows, summary rows, and daily snapshots
  only when real `Transfer`, `Deposit`, or `Withdraw` logs for tracked reserve
  wallets are processed.
- Dashboard reserve-yield readers prefer
  `NEXT_PUBLIC_RESERVE_YIELD_HASURA_URL`; when unset they fall back to
  `NEXT_PUBLIC_HASURA_URL` for compatibility with the pre-split deployment.

## Why This Avoids The Hosted Replay Stall Class

The failed hosted experiments stalled at Envio v3 synthetic `onBlock` batch
boundaries (`5000`/`15000` synthetic items). The dedicated reserve-yield entry
point excludes the heartbeat entirely, so the indexer backfills only real
Ethereum logs for the configured sUSDS/stETH contracts. Any reserve replay
failure is isolated to the reserve-yield project and cannot block Celo/Monad
FPMM, CDP, or bridge indexing.

## Degraded Behavior

- If the dedicated reserve endpoint is unset, dashboard reserve-yield history
  uses the existing production Hasura endpoint.
- If the endpoint, schema, or summary rows are missing, the revenue page keeps
  forecast rows visible and labels earned-yield actuals as pending/unavailable.
- If daily snapshots exist but stop advancing, the revenue page marks reserve
  history stale after the latest snapshot day and renders later reserve actuals
  as `N/A`.

## First-Block Verification

The reserve config currently starts at block `19111760`, the existing checked-in
first tracked stETH movement:

```text
0x297cbad231aa43b915ade1b699b8b0257babe6fff0b62e564d422daace021731
```

Before promoting a hosted reserve-yield project, re-derive first tracked
movements from source-of-truth Ethereum logs for every wallet in:

- `indexer-envio/src/handlers/susds/shared.ts`
- `indexer-envio/src/handlers/steth/shared.ts`

Use an archive-capable Ethereum RPC or an Envio HyperSync API token. The public
RPCs checked on 2026-06-29 either rejected archive log ranges or required a
token, so this PR does not claim hosted replay proof.

Query these event signatures over bounded ranges through the archive RPC:

```text
sUSDS 0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD
  Transfer(address indexed from,address indexed to,uint256)
  Deposit(address indexed sender,address indexed owner,uint256 assets,uint256 shares)
  Withdraw(address indexed sender,address indexed receiver,address indexed owner,uint256 assets,uint256 shares)

stETH 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84
  Transfer(address indexed from,address indexed to,uint256)
```

For each tracked wallet, query every indexed wallet position (`from`, `to`,
`sender`, `owner`, `receiver`) and set the config start block to the minimum
hit across all tracked wallets and contracts.

Example `cast` shape for one wallet/topic pair:

```bash
cast rpc --rpc-url "$ETHEREUM_ARCHIVE_RPC_URL" eth_getLogs \
  '[{"address":"0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84","fromBlock":"0x112a880","toBlock":"latest","topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x000000000000000000000000d0697f70e79476195b742d5afab14be50f98cc1e",null]}]'
```

## Hosted Promotion Gate

Do not wire `NEXT_PUBLIC_RESERVE_YIELD_HASURA_URL` to production until:

1. `pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test` passes.
2. A fresh hosted reserve-yield deployment starts from an unsynced state.
3. The Ethereum deployment advances beyond the old stall boundaries and catches
   up to head.
4. The dashboard `/revenue` page shows restored reserve actuals from the
   dedicated endpoint and continues to label stale/partial data correctly.
