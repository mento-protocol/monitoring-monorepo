---
title: Reserve-Yield Indexer Topology
status: active
owner: eng
canonical: true
last_verified: 2026-08-24
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Reserve-Yield Indexer Topology

Reserve-yield actuals are part of the production `mento` Envio project. The
primary hosted project uses `indexer-envio/config.multichain.mainnet.yaml` for
Ethereum reserve-yield events, Celo, Monad, and Polygon; no separate hosted
Envio project or dashboard endpoint is required.

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
  launch-aligned sUSDS and stETH samplers from [`ADR 0071`](../adr/0071-susds-launch-aligned-daily-sampler.md)
  and [`ADR 0034`](../adr/0034-steth-wallet-daily-sampler.md).
- The primary entry point does not register the historical every-block sUSDS
  heartbeat.
- sUSDS event handlers write movement and summary rows for tracked reserve
  wallets. The bounded sampler writes at most one daily row per UTC day and
  captures quiet-period share-price growth.
- stETH daily snapshots are keyed by chain, wallet, and day, baseline at the
  final Ethereum block before `2026-03-03T00:00:00Z`, and skipped as a batch
  when any required historical wallet `balanceOf` read is unavailable. The
  dashboard joins them to current reserve holdings by wallet.
- Dashboard reserve-yield readers use `NEXT_PUBLIC_HASURA_URL`.

## Why This Avoids The Hosted Replay Stall Class

The failed hosted experiments stalled at Envio v3 synthetic `onBlock` batch
boundaries (`5000`/`15000` synthetic items). The hosted entry point excludes
the historical every-block sUSDS heartbeat and uses 600-block sUSDS/stETH
samplers. That keeps replay work bounded enough to share the existing hosted
project instead of paying for an additional Envio deployment.

## Degraded Behavior

- If the shared endpoint, schema, or summary rows are missing, the revenue page keeps
  forecast rows visible and labels earned-yield actuals as pending/unavailable.
- If the `StethYieldDailySnapshot` query fails, the revenue page marks reserve
  actuals unavailable even when current stETH exposure is zero. A failed query
  cannot distinguish a never-held wallet from a wallet that earned yield and
  later exited. A successful empty query with proven-zero current exposure
  remains available. Missing, stale, or incomplete snapshots for a tracked
  current wallet also keep principal and forecast visible while actuals remain
  unavailable.
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

sUSDS and stETH launch actuals require launch-baseline rows at the final
pre-launch Ethereum block. The checked-in baseline is block `24573203`; sUSDS
uses its pre-launch share price with the v3 launch-day timestamp, and both
samplers use the bounded 600-block cadence. Re-check the block before changing
the launch timestamp or start-block assumptions. A zero-only sUSDS launch row
remains the revenue delta baseline, and historical rows remain in actual
revenue. The dashboard excludes that aggregate from freshness when the current
API returns a clean null-or-zero yield state and the classification, coverage,
source, and signal fields prove no current exposure. Historical rows alone do
not reactivate freshness.

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

Before promoting a hosted reindex with Ethereum reserve-yield enabled, require:

1. `pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test` passes.
2. A fresh hosted deployment starts from an unsynced state.
3. The deployment advances beyond the old stall boundaries and catches
   up to head.
4. `pnpm deploy:indexer:verify <commit>` returns synced chain status plus
   non-empty `Pool`, sUSDS, and stETH GraphQL probe rows. It reads the target
   commit schema and uses `SusdsYieldLaunchBaseline` as the sampler capability
   marker. When the marker exists, it requires the exact immutable
   `1-susds-launch` row and a post-launch `SusdsYieldDailySnapshot` whose
   `sampledAtBlock` is fresh against the Ethereum processed head and whose
   `sampledAtTimestamp` is fresh against verifier time. A legacy rollback
   schema without the marker omits all sampler-only probes and checks. An
   unreadable or uninspectable schema fails closed and retains the strict
   sampler requirements.

After promotion:

5. Wait the full five-minute static-endpoint propagation window.
6. `pnpm deploy:indexer:verify <commit> --prod` passes against the static
   production endpoint and requires that exact commit to be production.
7. An authorized same-origin request to production
   `/api/reserve-yield?closeout=<short-commit>` with `cache: "no-store"`
   returns HTTP 200. The query value marks the target in browser and network
   logs and gives it a distinct shared HTTP cache key; the route does not read
   it. `earnedYieldError` must be `null`, and
   `susdsYieldSignalUnavailable` must be `false`,
   `reserveCurrentHoldingsClassificationFailed` must be `false`, and
   `susdsSnapshotSourceRequired` must be a boolean.
   `hasUnindexedSusdsHolding` must be `false`. Treat
   `susdsSnapshotSourceRequired: true` as current sUSDS exposure that exists or
   cannot be ruled out. A positive finite sUSDS holding must not pair with a
   false signal. A true current source signal or a nonzero historical earned
   signal requires finite `susdsEarnedYieldUsd` and a valid
   `susdsEarnedYieldAsOf`. The aggregate `earnedYieldAsOf` is not sUSDS
   evidence because stETH can supply it independently. A true current source
   signal also requires an sUSDS holding with finite
   `earnedYieldUsd`, so malformed sUSDS exposure without a usable holding fails
   closeout. A clean state without either signal may return
   `susdsEarnedYieldUsd: null` or finite zero and does not require an sUSDS
   holding or `susdsEarnedYieldAsOf`.
8. If a true current sUSDS source signal or a nonzero historical signal exists, the
   dashboard `/revenue` page shows sUSDS reserve actuals without a pending,
   unavailable, or stale label. In a clean state without either signal, absent
   sUSDS history does not add one of those labels and no current sUSDS actual is
   required. The browser console has no errors.

The manual proof that motivated this gate was completed for deployment
`6bed96e` on 2026-07-03 after adding an archive-capable `ENVIO_RPC_URL_1` in
Envio Cloud and promoting the caught-up deployment to production.
