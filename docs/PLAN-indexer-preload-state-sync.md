---
title: Preload-Safe FPMM State-Sync Effects (Stage 1)
status: active
owner: eng
canonical: false
last_verified: 2026-09-25
doc_type: plan
scope: indexer-envio
review_interval_days: 180
garden_lane: notes-plans-archive
---

# Preload-Safe FPMM State-Sync Effects (Stage 1)

Stage-1 design for issue #1394: let Envio's concurrent preload pass issue the
RPC reads of `FPMM.UpdateReserves` and `FPMM.Rebalanced`, and keep every Pool
and breach decision in the ordered processing pass. Nothing is implemented. The
operator approves this note first. A separate implementation issue follows only
with the operator's OK.

Non-canonical plan. Every `file:line` below was read on `origin/main` at
`9bee8a75`. Paths are relative to `indexer-envio/src/` unless they start with
`docs/` or `test/` (`indexer-envio/test/`).

## Problem

Both handlers return at the preload guard before any effect runs
(`handlers/fpmm/state-sync.ts:256`, `:438`). All RPC fallback and self-heal
reads therefore run in ordered processing, one event at a time, so archive-RPC
latency sets hosted replay speed. An earlier attempt ran the RPC work in
preload. Pool writes then did not reach later handlers in the same batch, and
breach rows closed with `endedByEvent = "unknown"` although a `Rebalanced`
followed (`handlers/fpmm/state-sync.ts:243-250`). `FPMM.rebalance()` emits two
`UpdateReserves` and then one `Rebalanced` in one transaction; `Rebalanced`
depends on the reserves the two earlier handlers wrote
(`handlers/fpmm/state-sync.ts:463-474`).

## Effect Inventory

Key inputs: **E** = event field (phase-stable). **S** = Pool state (can change
between preload and ordered processing). "Gate" is the condition for the call.

| #   | Effect (definition)                                                                                                     | Reached through                                                                                                                                              | Key inputs                                             | Gate                                                                          | Current failure behavior                                                                                             | Stage 1                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | `rebalancingStateEffect`, `cache: false` (`rpc/effects.ts:556-575`)                                                     | `resolveRebalanceState` → `fetchAuthoritativeRebalanceState` (`handlers/fpmm/state-sync.ts:123-127`, `:155-162`)                                             | chainId E, poolAddress E, blockNumber E                | S: entity derive returns null (`priceDifference.ts:302-311`, `:324`)          | `null`; the handler skips the oracle delta and the health sample (`handlers/fpmm/state-sync.ts:334`, `:390`, `:612`) | Preload                                  |
| 2   | `medianTimestampEffectForChain(chainId)`, `cache: false` (`rpc/median-timestamp-effect.ts:29-88`)                       | same helper (`handlers/fpmm/state-sync.ts:128-134`)                                                                                                          | chainId E, rateFeedID S, blockNumber E                 | S: derive null and a feed resolves                                            | `null`; no `oracleOk` or `lastOracleReportAt` promotion (`handlers/fpmm/state-sync.ts:136-144`, `:345-348`)          | Preload                                  |
| 3   | `referenceRateFeedIDEffect`, `cache: true`, no cache on null (`rpc/effects.ts:203-223`)                                 | `resolveReferenceRateFeedForOracleRead` (`handlers/fpmm/oracle-recovery.ts:15-19`); `upsertPool` → `healReferenceRateFeed` (`pool/upsert-stages.ts:118-127`) | chainId E, poolAddress E                               | S: `referenceRateFeedID === ""`                                               | `null`; no median read, feed stays empty                                                                             | Preload when the preloaded feed is empty |
| 4   | `rebalanceIncentiveAtBlockEffect`, `cache: false` (`rpc/effects.ts:577-596`)                                            | direct in `Rebalanced` (`handlers/fpmm/state-sync.ts:517-522`)                                                                                               | chainId E, poolAddress E, blockNumber E                | S: `rebalanceReward !== -2` (`handlers/fpmm/state-sync.ts:462`)               | `null` → `rewardUsd = ""` (`handlers/fpmm/state-sync.ts:797`); missing getter → `-2` (`rpc/pool-fees.ts:208`)        | Preload                                  |
| 5   | `reservesEffect`, `cache: false` (`rpc/effects.ts:535-554`)                                                             | direct in `Rebalanced` (`handlers/fpmm/state-sync.ts:489-496`)                                                                                               | chainId E, poolAddress E, blockNumber − 1 E            | module scratch miss (`handlers/fpmm/state-sync.ts:483-488`)                   | `null` → zero amount deltas (`handlers/fpmm/state-sync.ts:757`)                                                      | Keep processing-only                     |
| 6   | `invertRateFeedEffect`, `cache: true`, no cache on miss (`rpc/effects.ts:247-266`)                                      | `selfHealInvertRateFeed` (`pool/self-heal.ts:48-51`) from `handlers/fpmm/state-sync.ts:276`, `:457` and `pool.ts:303`                                        | chainId E, poolAddress E                               | S: not known, `source !== ""`, not a VirtualPool (`pool/self-heal.ts:44`)     | `-1`; no heal, derive stays off (`priceDifference.ts:303`)                                                           | Keep processing-only                     |
| 7   | `tokenDecimalsScalingEffect` (nested `erc20DecimalsEffect`), `cache: true`, no cache on miss (`rpc/effects.ts:301-352`) | `selfHealTokenDecimals` (`pool/self-heal.ts:98-111`) from `handlers/fpmm/state-sync.ts:274`, `:455` and `pool.ts:334`                                        | chainId E, poolAddress E, fn, fallbackTokenAddress S   | S: decimals unknown and both tokens set (`pool/self-heal.ts:85`, `:96`)       | `null`; no heal, derive stays off (`priceDifference.ts:310`)                                                         | Keep processing-only                     |
| 8   | `rebalanceThresholdsEffect`, `cache: false` (`rpc/effects.ts:280-298`)                                                  | `selfHealRebalanceThresholds` (`pool/self-heal.ts:136-140`) from `handlers/fpmm/state-sync.ts:272`, `:453`                                                   | chainId E, poolAddress E, blockNumber E                | S: thresholds unknown (`pool/self-heal.ts:128-133`)                           | `null`; Pool unchanged, derive stays off (`priceDifference.ts:302`)                                                  | Keep processing-only                     |
| 9   | `reportExpiryEffect`, `cache: false` (`rpc/effects.ts:645-664`)                                                         | `upsertPool` → `healReferenceRateFeed` (`pool/upsert-stages.ts:130-134`)                                                                                     | chainId E, rateFeedID (effect 3 output), blockNumber E | S: feed healed in this event                                                  | `null`; no `oracleExpiry` delta                                                                                      | Keep processing-only                     |
| 10  | `feesEffect`, `cache: true` (`rpc/effects.ts:366-372`)                                                                  | `upsertPool` → `healPoolFees` (`pool/upsert-stages.ts:170-173`)                                                                                              | chainId E, poolAddress E                               | S: a fee is `-1` (`pool/upsert-stages.ts:164-169`)                            | `null`; retry on the next event                                                                                      | Keep processing-only                     |
| 11  | `vpExchangeIdEffect`, `cache: true`, not-VP `null` cached (`rpc/effects.ts:955-986`)                                    | `upsertPool` → `selfHealWrappedExchangeId` (`pool.ts:326`, `pool/self-heal.ts:196-199`)                                                                      | chainId E, vpAddress E                                 | S: incomplete wrapped link; always true for an FPMM (`pool/self-heal.ts:505`) | `null`; for FPMM addresses the VP follow-on effects (`pool/self-heal.ts:556`) are never reached                      | Keep processing-only; watch `hit~`       |

The markers name five helpers: `selfHealInvertRateFeed`,
`selfHealTokenDecimals`, `selfHealRebalanceThresholds`, `resolveRebalanceState`
and `upsertPool` (`handlers/fpmm/state-sync.ts:253-255`, `:435-437`). Rows 1-3
cover `resolveRebalanceState`; rows 6-8 cover the three self-heal helpers; rows
3, 6, 7 and 9-11 cover `upsertPool`. `upsertPool` also calls
`resolveFeedIdAndBreakerHalt` → `computeFeedHalted`, which reads entities only
(`breakers.ts:696-721`). `recordBreachTransition` issues no effect.

Rows 6-11 fire only for unhealed pools or hit a `cache: true` row. A healed
pool pays nothing. While a heal read keeps failing, rows 6-8, 10 and 11 skip
the cache and leave the sentinel unchanged, so they retry on every event and
scale with traffic. Stage 1 keeps them processing-only as a measured
degraded path (see Benchmark). Row 5 depends on the ordered
same-transaction scratch map, so it stays exempt. Rows 1-4 are the hot
block-scoped reads that stage 1 moves.

## Entity Reads In Preload

| Read                            | Preload today                                      | Processing                                                     | Stage-1 finding                                                                                                                                              |
| ------------------------------- | -------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Pool`                          | `maybePreloadPool` → `Pool.get` (`pool.ts:92-121`) | `Pool.get` (`handlers/fpmm/state-sync.ts:265`, `:449`)         | Unchanged                                                                                                                                                    |
| Open `DeviationThresholdBreach` | `get("${poolId}-${startedAt}")` (`pool.ts:97-101`) | `getWhere({poolId, startedAt})` (`deviationBreach.ts:114-119`) | New rows use an entropy id (`deviationBreach.ts:93-107`, `:141`), so the preload key matches only legacy rows. Stage 1 warms the same `getWhere` in preload. |

## Preload/Processing Handshake

Rule source: `docs/pr-checklists/indexer-handler-invariants.md:40-50`. Envio
reuses a preload effect result in processing only for the identical effect
object and input (`rpc/median-timestamp-effect.ts:75-76`).

1. Both phases call one reader, `readStateSyncEffects(context, event, pool)`,
   before `maybePreloadPool`. `pool` is that phase's own `Pool.get` result. The
   reader requests each of rows 1-4 when that row's gate holds for that
   `pool`; row 4 also requires a `Rebalanced` event and keeps the `-2`
   unsupported-getter skip. If `pool` is undefined, it requests rows 1 and 3,
   plus row 4 for `Rebalanced` (event-keyed only). Whenever the reader
   requests row 3 and it returns a feed, the reader then requests row 2 with
   that feed, as processing does (`handlers/fpmm/state-sync.ts:116-134`).
2. One key builder per effect produces the input for the reader and for the
   existing call site. Identical keys are then true by construction.
3. Preload returns after the reader and the Pool and breach warm-up. Preload
   makes no entity write, no `upsertPool` call and no scratch-map mutation.
4. Processing derives every gate again from ordered state. It consumes the
   reader's results. When ordered state opens a gate that preload did not
   open, processing requests the same key and pays one serialized read; this
   is today's behavior. When preload opened a gate that processing does not
   need, the result is unused and costs one RPC.
5. No module-scoped map carries a gate or a result across phases. The existing
   scratch map stays processing-only.

Correctness therefore does not depend on preload. The chain state at a block
fixes each block-scoped result. All Pool, breach and reserve decisions still
read ordered state. The earlier attempt ran handler state logic in preload;
this design keeps preload to effect requests and entity reads.

### Same-transaction ordering

| Event (same tx)     | Preload                                          | Processing (ordered)                                                                                                                                                                  |
| ------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UpdateReserves` #1 | Reader keys from pre-batch Pool; no writes       | Captures pre-rebalance reserves (`handlers/fpmm/state-sync.ts:282-288`); `upsertPool` source `fpmm_update_reserves` holds the breach anchor (`pool/health.ts:295-297`)                |
| `UpdateReserves` #2 | Same                                             | Same hold; reserves advance                                                                                                                                                           |
| `Rebalanced`        | Reader keys from pre-batch Pool, including row 4 | Reads the post-UR Pool; source `fpmm_rebalanced` closes the breach as `"rebalance"` with `endedByStrategy` (`deviationBreach.ts:58-60`, `:281-292`); deltas use the captured reserves |

## Benchmark

| Counter                                                                                                                 | Source                                                   | Use                                                    |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| Handler `n`, `avg`, `max` for `FPMM.UpdateReserves`, `FPMM.Rebalanced`                                                  | `INDEXER_PERF` summary (`performance.ts:107-114`)        | Latency; `avg` mixes phases (`performance.ts:254-263`) |
| Effect `req`, `exec`, `hit~` (= req − exec) for rows 1-4                                                                | `performance.ts:116-124`, `rpc/tracked-effect.ts:10-26`  | Reuse proof: `hit~` should approach preload requests   |
| `envio_preload_handler_seconds`, `envio_processing_handler_seconds`, `envio_effect_call_total`, `envio_progress_events` | Envio metrics (`.agents/skills/envio/performance.md:48`) | Phase-split throughput                                 |

The summary prints only the top five entries per table
(`performance.ts:101`), so the counters for rows 1-11 may not appear. One
throwaway benchmark commit therefore prints `req` and `exec` for every row
and every counter the success rules use. Both runs carry that commit (see
Range).

- **Source.** Two hosted debug deployments of `config.multichain.mainnet.yaml`
  with `INDEXER_PERF=1` and `INDEXER_PERF_LOG_INTERVAL_EVENTS=10000`
  (`indexer-envio/README.md:192-203`), neither promoted. The baseline is the
  stage-1 merge base; the candidate is the stage-1 head. Capture status and
  metrics with `pnpm deploy:indexer:perf <commit> --json`; only the JSON output
  includes the metrics (`scripts/deploy/deploy-indexer-perf.mjs:299-319`)
  (`indexer-envio/README.md:205-208`). That script keeps only `error,warn`
  logs (`scripts/deploy/deploy-indexer-perf.mjs:193-205`), but the `[perf]`
  summary is an info log (`performance.ts:147-152`). The benchmark run therefore adds
  an info-level retrieval of the `[perf]` lines, for example
  `envio-cloud deployment logs` with `--level info`.
- **Range.** Each chain's configured start block to one fixed end block per
  chain, recorded before the baseline starts. `config.multichain.mainnet.yaml`
  sets no end block, and hosted builds load it through the pinned
  `config.yaml` alias (`scripts/indexer-handler-invariant-contract.test.mjs:157-167`).
  So the throwaway benchmark commit also adds the `end_block` values to that
  file. Apply the same commit on top of the merge base and on top of the
  stage-1 head, and deploy those two benchmark commits. Never merge them.
- **Success.** Processed `UpdateReserves` + `Rebalanced` calls per processing
  handler second is at least 1.30× the baseline. Whole-replay time to the end
  blocks is not slower. Executions of rows 1 and 4 are at most 1.10× the
  baseline. If executions of rows 6-8, 10 and 11 exceed 5% of all effect
  executions in the baseline, stage 1 stops and reports the numbers. It does
  not claim success, and it does not preload those rows; that needs its own
  design and operator decision.
- **No correctness regression.** Over the range, a paged row export (no
  aggregates) shows zero differences between runs in `DeviationThresholdBreach`
  and in every other entity the two handlers write: `RebalanceEvent`, `Pool`,
  `OracleSnapshot`, `ReserveUpdate`, `PoolSnapshot` and `PoolDailySnapshot`
  (`handlers/fpmm/state-sync.ts:203`, `:227`, `:415`, `:653`;
  `pool/snapshots.ts:72`, `:76`, `:157`). Compare all fields of every row.

## Stage Split

| Stage | Scope                                                                     | Marker sites (all cite #1394 today)                                                          |
| ----- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1     | `FPMM.UpdateReserves`, `FPMM.Rebalanced`: rows 1-4 and the breach warm-up | `handlers/fpmm/state-sync.ts:251-255`, `:433-437`, `:490`, `:517`, `:684`, `:720`, `:737`    |
| 2     | Swaps and liquidity: `FPMM.Swap`, `Mint`, `Burn`, `VirtualPool.Swap`      | `handlers/fpmm.ts:70`, `handlers/fpmm/liquidity.ts:19`, `:72`, `handlers/virtualPool.ts:157` |
| 3     | `MedianUpdated` and the Broker path                                       | `handlers/broker.ts:542`, `handlers/biPoolManager.ts:546`                                    |
| none  | `RebalanceThresholdUpdated` (governance cardinality)                      | `handlers/fpmm/limits-and-fees.ts:379`: retarget only                                        |

**Stage-1 files.** `handlers/fpmm/state-sync.ts` (reader, key builders,
handler bodies exported for tests), `pool.ts` (breach warm-up through
`getWhere`), plus a comment-only retarget of the `#1394` markers in the stage
2, stage 3 and governance files in the table above. The benchmark commit is
throwaway and is not part of stage 1.

**Stage-1 tests.** A new `test/stateSyncPreload.test.ts` on the
`test/susds.test.ts:805-869` pattern: preload writes no entity; with the same
Pool state in both phases, every processing key for rows 1-4 was requested in
preload (extra preload keys are allowed); a separate case opens a gate only
in processing and shows the one serialized fallback read; the two-`UpdateReserves`
→ `Rebalanced` sequence with preload first closes the breach as `"rebalance"`
and keeps pre-rebalance deltas; a pool seeded earlier in the batch derives
without the preloaded RPC; a preloaded Pool with `rebalanceReward === -2`
requests no row 4. `test/rebalancedUsd.test.ts`,
`test/stateSyncReconcile.test.ts`, `test/deviationBreach.test.ts` and
`test/code-quality-invariants.test.ts` stay green. The repo harness has no
preload hook, so these tests call the exported handlers directly.

**Stage-1 marker changes.**

| Line                                                      | Change                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `handlers/fpmm/state-sync.ts:517`                         | Remove `preload-effect-exempt`; processing consumes the reader result                                  |
| `handlers/fpmm/state-sync.ts:251-252`, `:433-434`         | Narrow the note: rows 1-4 are awaited in preload; helpers stay processing-only for ordered Pool writes |
| `handlers/fpmm/state-sync.ts:253-255`, `:435-437`         | Keep `preload-effect-helpers`; helpers still run after the guard                                       |
| `handlers/fpmm/state-sync.ts:490`, `:684`, `:720`, `:737` | Keep; retarget from #1394 to the implementation issue                                                  |

Stage 1 also retargets every other `#1394` marker in the table above, because
this note's PR closes #1394.

**Rollback.** No schema change and no new entity. Before promotion, do not
promote the candidate. After promotion, follow `docs/deployment.md:170-191`:
run `pnpm deploy:indexer:rollback <last-good-sha> --dry-run`, then the same
command without `--dry-run`, then revert the stage-1 commit on `main`.

## Open Questions

- Envio metrics labels: confirm that `envio_processing_handler_seconds` splits
  per handler. If it does not, the benchmark commit adds per-phase time to the
  `INDEXER_PERF` summary (`performance.ts:8-14` already counts calls per
  phase).
- Confirm that `INDEXER_PERF` can be set on a hosted debug deployment before
  the replay is scheduled.
