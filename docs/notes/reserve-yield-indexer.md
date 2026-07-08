---
title: Reserve-Yield Indexer Topology
status: active
owner: eng
canonical: true
last_verified: 2026-07-03
---

# Reserve-Yield Indexer Topology

Reserve-yield actuals are part of the production `mento` Envio project. The
primary hosted project uses `indexer-envio/config.multichain.mainnet.yaml` for
Ethereum reserve-yield events, Celo, and Monad; no separate hosted Envio project
or dashboard endpoint is required.

The reserve-yield test harness is:

```bash
pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test
```

It codegens `indexer-envio/config.multichain.mainnet.yaml` and runs the
sUSDS/stETH event suites with reserve-yield event tests enabled.

## Invariants

- Ethereum reserve-yield indexing shares the existing production Envio project
  and GraphQL endpoint.
- The primary entry point registers sparse sUSDS/stETH token events plus the
  launch-aligned stETH sub-daily wallet balance sampler from
  [`ADR 0034`](../adr/0034-steth-wallet-daily-sampler.md).
- The primary entry point does not register the historical sUSDS `onBlock`
  heartbeat.
- sUSDS event handlers write movement rows, summary rows, and daily snapshots
  only when real `Transfer`, `Deposit`, or `Withdraw` logs for tracked reserve
  wallets are processed.
- stETH daily snapshots are keyed by `chainId:token:wallet`, baseline at the
  final Ethereum block before `2026-03-03T00:00:00Z`, and skipped as a batch when
  any required historical wallet `balanceOf` read is unavailable.
- Dashboard reserve-yield readers use `NEXT_PUBLIC_HASURA_URL`.

## Why This Avoids The Hosted Replay Stall Class

The failed hosted experiments stalled at Envio v3 synthetic `onBlock` batch
boundaries (`5000`/`15000` synthetic items). The hosted entry point excludes the
historical sUSDS heartbeat entirely, so the indexer backfills real Ethereum logs
for the configured sUSDS/stETH contracts plus one sub-daily stETH wallet
balance sampler. That keeps the replay work bounded enough to share the existing
hosted project instead of paying for an additional Envio deployment.

## Degraded Behavior

- If the shared endpoint, schema, or summary rows are missing, the revenue page keeps
  forecast rows visible and labels earned-yield actuals as pending/unavailable.
- If `StethYieldDailySnapshot` is missing, stale, or incomplete for a tracked
  current stETH wallet, the revenue page keeps stETH principal and forecast
  visible while labeling stETH earned-yield actuals as pending/unavailable.
- If daily snapshots exist but stop advancing, the revenue page marks reserve
  history stale after the latest snapshot day and renders later reserve actuals
  as `N/A`.

## First-Block Verification

The mainnet config currently starts Ethereum reserve-yield at block `19111760`,
the existing checked-in first tracked stETH movement:

```text
0x297cbad231aa43b915ade1b699b8b0257babe6fff0b62e564d422daace021731
```

Before promoting a hosted reindex that includes Ethereum reserve-yield, re-derive
first tracked movements from source-of-truth Ethereum logs for every wallet in:

- `indexer-envio/src/handlers/susds/shared.ts`
- `indexer-envio/src/handlers/steth/shared.ts`

Use an archive-capable Ethereum RPC or an Envio HyperSync API token for broad
absence/range proofs. Public RPCs checked on 2026-06-29 rejected archive log
ranges or required a token. PublicNode receipt lookups were enough to verify
the first production movement rows on 2026-07-03, but broad negative scans may
still need a token-authenticated archive endpoint or chunked provider-specific
queries.

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
`sender`, `owner`, `receiver`) and set
`ENVIO_START_BLOCK_ETHEREUM_RESERVE_YIELD` or the config default to the minimum
hit across all tracked wallets and contracts.

stETH launch actuals also require the launch-baseline block from ADR 0034. The
checked-in baseline is Ethereum block `24573203`; re-check it before changing
the launch timestamp or start-block assumptions.

Example `cast` shape for one wallet/topic pair:

```bash
cast rpc --rpc-url "$ETHEREUM_ARCHIVE_RPC_URL" eth_getLogs \
  '[{"address":"0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84","fromBlock":"0x112a880","toBlock":"latest","topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x000000000000000000000000d0697f70e79476195b742d5afab14be50f98cc1e",null]}]'
```

### 2026-07-03 Production Proof

Deployment `6bed96e` was freshly replayed with Ethereum reserve-yield enabled
and promoted to the static production endpoint:

```bash
pnpm exec envio-cloud deployment status mento 6bed96e mento-protocol -o json
pnpm exec envio-cloud indexer get mento mento-protocol -o json
```

The promoted deployment had non-empty
`timestamp_caught_up_to_head_or_endblock` values on Ethereum `1`, Monad `143`,
and Celo `42220`. Production GraphQL returned reserve-yield rows from the shared
endpoint:

```bash
curl -sS 'https://indexer.hyperindex.xyz/2f3dd15/v1/graphql' \
  -H 'content-type: application/json' \
  --data-binary '{"query":"query FirstReserveRows { SusdsYieldMovement(limit: 3, order_by: {blockNumber: asc}) { id kind from to blockNumber txHash } StethYieldMovement(limit: 3, order_by: {blockNumber: asc}) { id kind from to blockNumber txHash } }"}'
```

First production rows and receipt checks:

| Path                      | Wallet                                       |      Block | Tx                                                                   | Receipt proof                                                                                                                                                                                                                                                                                  |
| ------------------------- | -------------------------------------------- | ---------: | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stETH `transfer_in`       | `0xd0697f70e79476195b742d5afab14be50f98cc1e` | `19111760` | `0x297cbad231aa43b915ade1b699b8b0257babe6fff0b62e564d422daace021731` | `cast receipt --rpc-url https://ethereum.publicnode.com 0x297cbad231aa43b915ade1b699b8b0257babe6fff0b62e564d422daace021731 --json` showed the stETH `Transfer` log at log index `0x163` from zero address to the tracked wallet.                                                               |
| sUSDS `deposit`           | `0xd0697f70e79476195b742d5afab14be50f98cc1e` | `22994825` | `0x6108b1483149133cc9057b80b0dfcc0b5d167a03e784a72e9f3dbe5c55fd4b8a` | `cast receipt --rpc-url https://ethereum.publicnode.com 0x6108b1483149133cc9057b80b0dfcc0b5d167a03e784a72e9f3dbe5c55fd4b8a --json` showed the sUSDS `Deposit` log at log index `0x34b` with owner `0xd0697f70e79476195b742d5afab14be50f98cc1e`, followed by the corresponding mint `Transfer`. |
| sUSDS `internal_transfer` | `0xd3d2e5c5af667da817b2d752d86c8f40c22137e1` | `25122170` | `0x68bd1f5caf51b8646f4c5d67633028e42404897691cdab13b5dfc71a922899f7` | `cast receipt --rpc-url https://ethereum.publicnode.com 0x68bd1f5caf51b8646f4c5d67633028e42404897691cdab13b5dfc71a922899f7 --json` showed the sUSDS `Transfer` log at log index `0x1c9` from `0xd0697f70e79476195b742d5afab14be50f98cc1e` to `0xd3d2e5c5af667da817b2d752d86c8f40c22137e1`.     |

Production GraphQL returned no stETH movement rows for
`0xd3d2e5c5af667da817b2d752d86c8f40c22137e1` as of the 2026-07-03 proof
query. Public broad `eth_getLogs` scans for that absence were blocked by archive
or range limits; use the archive scan shape above if the tracked wallet set
changes or if an absence proof is needed for a future audit.

## Hosted Promotion Gate

Do not promote a hosted reindex with Ethereum reserve-yield enabled until:

1. `pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test` passes.
2. A fresh hosted deployment starts from an unsynced state.
3. The deployment advances beyond the old stall boundaries and catches
   up to head.
4. `pnpm deploy:indexer:verify <commit>` returns synced chain status plus
   non-empty `Pool`, sUSDS, and stETH GraphQL probe rows.
5. The dashboard `/revenue` page shows restored reserve actuals from the
   shared endpoint and continues to label stale/partial data correctly.

The manual proof that motivated this gate was completed for deployment
`6bed96e` on 2026-07-03 after adding an archive-capable `ENVIO_RPC_URL_1` in
Envio Cloud and promoting the caught-up deployment to production.
