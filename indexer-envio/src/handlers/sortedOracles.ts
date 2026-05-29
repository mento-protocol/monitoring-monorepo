// ---------------------------------------------------------------------------
// SortedOracles event handlers (OracleReported, MedianUpdated, expiry)
// ---------------------------------------------------------------------------

import type { OracleSnapshot, Pool } from "envio";
import { indexer } from "../indexer.js";
import { eventId, asAddress, asBigInt, isVirtualPool } from "../helpers.js";
import {
  computePriceDifference,
  hasDegenerateReserves,
  pickActiveThreshold,
} from "../priceDifference.js";
import {
  computeHealthStatus,
  effectiveThreshold,
  isNeverRebalance,
  persistableThreshold,
  maybePreloadPool,
  nextDeviationBreachStartedAt,
  nextOpenBreachEntryThreshold,
  nextOpenBreachPeak,
  selfHealInvertRateFeed,
  selfHealTokenDecimals,
  upsertDailySnapshot,
  upsertOraclePriceDaily,
} from "../pool.js";
import { recordBreachTransition } from "../deviationBreach.js";
import { recordHealthSample } from "../healthScore.js";
import { computeMedianLineageNext } from "../oracleJump.js";
import {
  getPoolsByFeed,
  updatePoolsOracleExpiry,
  getPoolsWithReferenceFeed,
  getBreakerConfigsByFeed,
} from "../rpc.js";
import { reportExpiryEffect } from "../rpc/effects.js";
import {
  bootstrapAndResolveBreakerSnapshotFields,
  bootstrapFeedBreakerConfigs,
  nextMedianEMA,
  resolveBreakerSnapshotFields,
} from "../breakers.js";

function priceDifferenceForOracleSample(
  pool: Pool,
  decimalsTrustworthy: boolean,
  oraclePrice: bigint,
): bigint {
  return decimalsTrustworthy && !isVirtualPool(pool) && oraclePrice > 0n
    ? computePriceDifference(pool)
    : pool.priceDifference;
}

function degenerateReservesForOracleSample(
  pool: Pool,
  decimalsTrustworthy: boolean,
): boolean {
  return decimalsTrustworthy && !isVirtualPool(pool)
    ? hasDegenerateReserves(pool)
    : pool.degenerateReserves;
}

function shouldHoldOracleReportedCursor(pool: Pool): boolean {
  return !pool.tokenDecimalsKnown && !isNeverRebalance(pool);
}

function holdOracleReportedCursor(
  context: { Pool: { set: (pool: Pool) => void } },
  updatedPool: Pool,
  existing: Pool,
): void {
  context.Pool.set({
    ...updatedPool,
    oracleTimestamp: existing.oracleTimestamp,
    oracleOk: existing.oracleOk,
    oracleTxHash: existing.oracleTxHash,
    oraclePrice: existing.oraclePrice,
  });
}

// ---------------------------------------------------------------------------
// SortedOracles.OracleReported
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "SortedOracles", event: "OracleReported" },
  async ({ event, context }) => {
    const rateFeedID = asAddress(event.params.token);
    // Chain-scoped — getPoolsByFeed filters by chainId to prevent cross-chain
    // oracle bleed (same rateFeedID exists on both Celo and Monad). See rpc.ts.
    // Co-fetched with the BreakerConfig lookup so the preload phase warms
    // both entity caches in one pass; OracleReported is high-frequency.
    const [poolIds, breakerConfigs] = await Promise.all([
      getPoolsByFeed(context, event.chainId, rateFeedID),
      getBreakerConfigsByFeed(context, event.chainId, rateFeedID),
    ]);
    if (poolIds.length === 0) return;

    // Preload phase: seed Pool + open-breach-row lookups so Envio can
    // batch them, then bail. Also warm the per-feed Breaker entities the
    // baseline/threshold resolver will read in the processing phase — same
    // pattern as MedianUpdated below. See `maybePreloadPool` in pool.ts.
    if (context.isPreload) {
      await Promise.all([
        maybePreloadPool(context, poolIds),
        ...breakerConfigs.map(async (cfg) => {
          await context.Breaker.get(cfg.breaker_id);
        }),
      ]);
      return;
    }
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    const oracleTimestamp = event.params.timestamp;

    // Bootstrap-if-needed + resolve in one call. See helper doc; bootstrap
    // covers fresh-sync feeds whose BreakerBox events predate start_block.
    const breakerSnapshotFields =
      await bootstrapAndResolveBreakerSnapshotFields({
        context,
        chainId: event.chainId,
        rateFeedID,
        blockNumber,
        blockTimestamp,
        knownConfigsLength: breakerConfigs.length,
        poolsLength: poolIds.length,
      });

    // Each poolId is distinct (getPoolsByFeed returns unique rows) so pool
    // writes don't race. Fan out in parallel — on a rate feed shared by 5-10
    // pools this collapses N sequential awaits into 1 concurrent batch.
    await Promise.all(
      poolIds.map(async (poolId) => {
        const initial = await context.Pool.get(poolId);
        if (!initial) return;
        // Self-heal invertRateFeed before computePriceDifference reads it.
        // Without this, a pool deployed during an RPC blip whose only event
        // post-deploy is OracleReported would persist wrong-orientation
        // priceDifference / health / breach state until an FPMM event runs
        // upsertPool's heal.
        const existing = await selfHealTokenDecimals(
          context,
          await selfHealInvertRateFeed(context, initial),
        );

        // Resolve oracleExpiry from DB if already populated, otherwise fetch
        // via RPC (one-time seed — subsequent events use the DB value).
        const oracleExpiry =
          existing.oracleExpiry > 0n
            ? existing.oracleExpiry
            : ((await context.effect(reportExpiryEffect, {
                chainId: event.chainId,
                rateFeedID,
                blockNumber,
              })) ?? existing.oracleExpiry);

        const oraclePrice = event.params.value;

        // `lastOracleReportAt` is intentionally NOT advanced here.
        // OracleReported fires for every reporter, but the on-chain median's
        // freshness is bounded by the median reporter's timestamp — not the
        // max across all reporters. Tracking max-of-all here would let a
        // fresh non-median reporter extend our derive-path freshness gate
        // past the actual median's contract expiry. The pragmatic alternative
        // (per claude[bot] review on PR #358): only advance `lastOracleReportAt`
        // in the `MedianUpdated` handler using `blockTimestamp`. That's an
        // under-bound — if reporters are fresh but the median hasn't moved
        // recently, derive falls through to RPC. Safe by construction: never
        // passes stale-median data through the freshness gate.
        //
        // We DO advance `lastFreshReporterAt = max(prev, event.params.timestamp)`
        // here. Diagnostic-only field — see schema.graphql for why it can't
        // replace `lastOracleReportAt` as the freshness gate.
        const updatedPool: Pool = {
          ...existing,
          oracleTimestamp,
          oracleTxHash: event.transaction.hash,
          oracleOk: true,
          oraclePrice,
          oracleExpiry,
          oracleNumReporters: existing.oracleNumReporters,
          lastFreshReporterAt:
            oracleTimestamp > existing.lastFreshReporterAt
              ? oracleTimestamp
              : existing.lastFreshReporterAt,
          updatedAtBlock: blockNumber,
          updatedAtTimestamp: blockTimestamp,
        };
        // `tokenDecimalsKnown` gate: when decimals aren't known we cannot
        // compute a trustworthy `priceDifference` (`normalizeTo18` would
        // skew by `10^(18 - real_dec)`), and feeding the frozen-or-default
        // `existing.priceDifference` into the breach pipeline would let
        // `nextDeviationBreachStartedAt` / `recordBreachTransition` open or
        // close `DeviationThresholdBreach` rows from stale data — corrupting
        // breach durations and alert rollups. Skip the breach + health +
        // snapshot pipeline entirely; the Pool entity still advances
        // diagnostic fields (`oraclePrice`, `lastFreshReporterAt`) but the
        // FRESHNESS cursor (`oracleTimestamp` / `oracleOk`) is HELD on the
        // existing values — advancing them would let the dashboard's homepage
        // table + OG card (which recompute health from `oracleTimestamp` +
        // `priceDifference` without checking `hasHealthData`) classify a
        // pool with untrusted deviation data as "OK / fresh" instead of
        // degraded (codex P2 #3214513402, PR 1.6).
        // Mirrors the two-cursor model in state-sync.ts.
        //
        // Exception: never-rebalance pools (both split sides 0 + known)
        // don't need priceDifference math at all — `effectiveThreshold`
        // returns 1e12, the breach predicate / `computeHealthStatus` /
        // `nextDeviationBreachStartedAt` all short-circuit to OK / no-breach
        // regardless of priceDifference. Letting them through means uptime
        // accrual keeps moving on every oracle event even if decimals
        // self-heal stays stuck (e.g. governance-paused pool's fee tokens).
        if (shouldHoldOracleReportedCursor(updatedPool)) {
          holdOracleReportedCursor(context, updatedPool, existing);
          return;
        }

        // For the never-rebalance + decimals-untrusted fall-through case
        // above, computePriceDifference would normalize against schema-default
        // 18/18 and produce a fabricated value that gets persisted onto the
        // OracleSnapshot row. The breach predicate / `computeHealthStatus` /
        // `nextDeviationBreachStartedAt` ignore it (1e12 effective threshold
        // short-circuits everything to no-breach / OK), but consumers who
        // read the row's priceDifference directly (BreachEvent, oracle tab
        // detail) would see a fake non-zero value. Preserve existing instead.
        const decimalsTrustworthy = updatedPool.tokenDecimalsKnown === true;
        const priceDifference = priceDifferenceForOracleSample(
          updatedPool,
          decimalsTrustworthy,
          oraclePrice,
        );
        const degenerateReserves = degenerateReservesForOracleSample(
          updatedPool,
          decimalsTrustworthy,
        );
        const withDev = {
          ...updatedPool,
          priceDifference,
          degenerateReserves,
        };
        const deviationBreachStartedAt = nextDeviationBreachStartedAt(
          existing,
          withDev,
          blockTimestamp,
        );
        const withBreach = { ...withDev, deviationBreachStartedAt };
        const healthStatus = computeHealthStatus(withBreach, blockTimestamp);
        const finalPool = { ...withBreach, healthStatus };

        const breachPoolUpdate = await recordBreachTransition(
          context,
          existing,
          finalPool,
          {
            blockTimestamp,
            blockNumber,
            txHash: event.transaction.hash,
            logIndex: event.logIndex,
            source: "oracle_reported",
          },
        );

        // Health score: compute snapshot fields + update pool accumulators.
        // Pass `Number(effectiveThreshold(finalPool))` so asymmetric pools
        // whose active side currently sits at 0 still accrue uptime via the
        // 10000 fallback (raw `rebalanceThreshold` would route through the
        // no-data sentinel). `isNeverRebalance(finalPool)` short-circuits
        // governance-disabled pools to OK regardless.
        const effectiveBps = Number(effectiveThreshold(finalPool));
        const { snapshotFields, poolUpdate } = recordHealthSample(
          finalPool,
          priceDifference,
          effectiveBps,
          blockTimestamp,
          isNeverRebalance(finalPool),
        );
        const merged: Pool = {
          ...finalPool,
          ...poolUpdate,
          ...breachPoolUpdate,
        };
        // `recordHealthSample` may have flipped `hasHealthData: false → true`
        // on the first valid sample. The earlier `computeHealthStatus` call
        // ran against the OLD value (returning `N/A` via the new gate), so
        // `merged.healthStatus` is stale. Recompute against `merged` so the
        // persisted state is consistent (codex P2 PR #370 #3214748736).
        const persistedPool: Pool = {
          ...merged,
          healthStatus: computeHealthStatus(merged, blockTimestamp),
        };
        context.Pool.set(persistedPool);

        const snapshot: OracleSnapshot = {
          id:
            eventId(event.chainId, event.block.number, event.logIndex) +
            `-${poolId}`,
          chainId: event.chainId,
          poolId,
          timestamp: blockTimestamp,
          oraclePrice,
          oracleOk: true,
          numReporters: existing.oracleNumReporters,
          priceDifference,
          degenerateReserves,
          // Persist the effective threshold so asymmetric pools with active
          // side = 0 still show a non-zero denominator in the chart's
          // deviation-ratio math (raw 0 would render 0%/—). Use
          // `persistableThreshold` not `effectiveBps` directly: the 1e12
          // never-rebalance sentinel overflows `OracleSnapshot.rebalanceThreshold`'s
          // `Int!` (32-bit signed). Dashboards detect never-rebalance by joining
          // the Pool entity's `rebalanceThresholdsKnown` + above/below fields.
          rebalanceThreshold: persistableThreshold(finalPool),
          source: "oracle_reported",
          blockNumber,
          txHash: event.transaction.hash,
          // No breaker, or unseeded EMA / unconfigured referenceValue →
          // undefined (Envio's nullable codegen). The chart consumer falls
          // back to the current band for these rows.
          breakerBaselineAtSnapshot:
            breakerSnapshotFields?.breakerBaselineAtSnapshot,
          breakerThresholdAtSnapshot:
            breakerSnapshotFields?.breakerThresholdAtSnapshot,
          ...snapshotFields,
        };
        context.OracleSnapshot.set(snapshot);

        // Refresh the daily snapshot's frozen health counters even though no
        // pool-side activity (swap/rebalance/mint/burn/UR) fired. Without
        // this, a quiet pool whose only updates are oracle reports has no
        // PoolDailySnapshot rows after the last activity event, and the 7d
        // tile's "latest row <= sevenDaysAgo" anchor silently broadens past
        // 7 days instead of degrading to "—".
        await upsertDailySnapshot({
          context,
          pool: persistedPool,
          blockTimestamp,
          blockNumber,
        });
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// SortedOracles.MedianUpdated
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "SortedOracles", event: "MedianUpdated" },
  // eslint-disable-next-line max-lines-per-function -- Existing median handler coordinates pool fan-out and breaker mirrors.
  async ({ event, context }) => {
    const rateFeedID = asAddress(event.params.token);
    const oraclePrice = event.params.value;

    // Two parallel concerns share this event: pool-side oracle/breach state
    // (existing) and breaker-side EMA / lastMedianRate mirror (new). Look up
    // both up front so neither's emptiness suppresses the other, and so a
    // single preload-phase pass warms both entity caches.
    const [poolIds, breakerConfigs] = await Promise.all([
      getPoolsByFeed(context, event.chainId, rateFeedID),
      getBreakerConfigsByFeed(context, event.chainId, rateFeedID),
    ]);

    if (poolIds.length === 0 && breakerConfigs.length === 0) return;

    // Preload phase: warm pool + breaker entities, no writes. Mirrors
    // `maybePreloadPool` semantics — return without proceeding to writes.
    if (context.isPreload) {
      await Promise.all([
        maybePreloadPool(context, poolIds),
        ...breakerConfigs.map(async (cfg) => {
          await context.Breaker.get(cfg.breaker_id);
        }),
      ]);
      return;
    }

    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    // Eager bootstrap BEFORE the snapshot resolve. On a fresh sync where the
    // BreakerBox `BreakerAdded` / per-feed config events all predate
    // `start_block`, no event has yet hydrated `BreakerConfig` for this feed
    // — `resolveBreakerSnapshotFields` would return null and the first
    // MedianUpdated snapshot would persist null historical band fields,
    // permanently mis-classifying that row as "fallback to current band"
    // forever after. The mirror loop further down does its own bootstrap
    // for the EMA write path; lift it here so both writes see the same
    // hydrated entity set. `bootstrapFeedBreakerConfigs` is in-memory cached
    // per feed, so paying it once per process is free.
    let breakerConfigsHydrated = breakerConfigs;
    if (breakerConfigsHydrated.length === 0 && poolIds.length > 0) {
      await bootstrapFeedBreakerConfigs(
        context,
        event.chainId,
        rateFeedID,
        blockNumber,
        blockTimestamp,
      );
      breakerConfigsHydrated = await getBreakerConfigsByFeed(
        context,
        event.chainId,
        rateFeedID,
      );
    }

    // Resolve breaker baseline/threshold BEFORE the per-pool fan-out so
    // every snapshot row reads the SAME pre-event EMA — the comparator the
    // contract used to evaluate this median update. The mirror loop below
    // recomputes EMA AFTER all snapshot writes, which is what we want:
    // historical snapshots capture the EMA-at-evaluation-time, not the
    // post-blend value. Returns null when no trip-able breaker exists or
    // EMA is unseeded — chart falls back to current band for those rows.
    const breakerSnapshotFields = await resolveBreakerSnapshotFields(
      context,
      event.chainId,
      rateFeedID,
    );

    await Promise.all(
      // eslint-disable-next-line max-lines-per-function -- Existing per-pool fan-out preserves oracle, breach, health, and snapshot updates together.
      poolIds.map(async (poolId) => {
        const initial = await context.Pool.get(poolId);
        if (!initial) return;
        const existing = await selfHealTokenDecimals(
          context,
          await selfHealInvertRateFeed(context, initial),
        );

        const oracleExpiry =
          existing.oracleExpiry > 0n
            ? existing.oracleExpiry
            : ((await context.effect(reportExpiryEffect, {
                chainId: event.chainId,
                rateFeedID,
                blockNumber,
              })) ?? existing.oracleExpiry);

        const lineage = computeMedianLineageNext(
          existing,
          oraclePrice,
          blockTimestamp,
        );

        const updatedPool: Pool = {
          ...existing,
          oraclePrice,
          oracleTimestamp: blockTimestamp,
          oracleTxHash: event.transaction.hash,
          oracleOk: true,
          oracleExpiry,
          oracleNumReporters: existing.oracleNumReporters,
          ...lineage,
          // Advance only on MedianUpdated (block timestamp). Under-bound on
          // contract median-reporter expiry — see OracleReported handler for
          // why this is safer than tracking max(reporter timestamps).
          // Freeze on zero-median outages: `medianLive=false` keeps the
          // prior fresh anchor so the next post-outage state-sync event
          // doesn't see a freshness gate that the contract would also fail.
          lastOracleReportAt: lineage.medianLive
            ? blockTimestamp
            : existing.lastOracleReportAt,
          updatedAtBlock: blockNumber,
          updatedAtTimestamp: blockTimestamp,
        };
        // The median itself can flip reservePrice from one side of the
        // oracle to the other, switching which threshold the contract uses.
        // Re-pick the active threshold here so breach/health predicates
        // (`effectiveThreshold(pool)`) see the direction-correct value
        // until the next state-sync event re-confirms.
        //
        // Gate on `invertRateFeedKnown`: an inverted pool whose deploy-time
        // invert-read failed and whose self-heal also returned undefined would
        // otherwise persist the wrong-side threshold from this re-pick. With
        // the gate, we keep the prior threshold until the orientation lands.
        //
        // Also gate on `lastMedianPrice > 0n` so a zero-median outage at
        // the first MedianUpdated for a pool doesn't fall through to
        // `pickActiveThreshold`'s degenerate-reserve `above` fallback,
        // overwriting the seeded broad threshold from a value the
        // contract wouldn't trust.
        //
        // Gate on `medianLive`: a zero-median outage following a prior
        // live median keeps `lastMedianPrice > 0` (frozen) but flips
        // `medianLive` false. Without this gate the re-pick would still
        // run from stale data the contract wouldn't evaluate while down.
        //
        // Gate on `reserves > 0`: a `MedianUpdated` arriving before
        // FPMMDeployed has written reserves (or after a side has been
        // drained) would fall through to `pickActiveThreshold`'s
        // degenerate-reserve `above` fallback, overwriting the seeded
        // threshold from a reserve ratio that can't be evaluated.
        // `tokenDecimalsKnown` gates `pickActiveThreshold` for the same reason
        // it gates `computePriceDifference` below: both call paths run through
        // `reservePriceVsOracleRef`, which normalizes reserves against the
        // on-entity decimals. Without real decimals, the active-side pick is
        // computed against the schema-default 18/18 pair and could flip to the
        // wrong side on a non-18-decimal pool whose self-heal hasn't landed yet.
        const rebalanceThreshold =
          updatedPool.rebalanceThresholdsKnown &&
          updatedPool.invertRateFeedKnown &&
          updatedPool.tokenDecimalsKnown &&
          updatedPool.lastMedianPrice > 0n &&
          updatedPool.medianLive &&
          updatedPool.reserves0 > 0n &&
          updatedPool.reserves1 > 0n
            ? pickActiveThreshold(
                {
                  reserves0: updatedPool.reserves0,
                  reserves1: updatedPool.reserves1,
                  // Zero medians freeze `lastMedianPrice`; threshold direction must
                  // keep following that frozen value rather than the transient 0
                  // event payload, or outages incorrectly flip to the `above` side.
                  oraclePrice: updatedPool.lastMedianPrice,
                  invertRateFeed: updatedPool.invertRateFeed,
                  token0Decimals: updatedPool.token0Decimals,
                  token1Decimals: updatedPool.token1Decimals,
                },
                {
                  above: updatedPool.rebalanceThresholdAbove,
                  below: updatedPool.rebalanceThresholdBelow,
                },
              )
            : updatedPool.rebalanceThreshold;
        const withThreshold: Pool = { ...updatedPool, rebalanceThreshold };

        // `tokenDecimalsKnown` gate — same rationale as the OracleReported
        // handler, including the never-rebalance exception (those pools
        // record OK uptime samples with no priceDifference math).
        // Pool entity still advances diagnostic fields (`oraclePrice`, median
        // lineage), but the FRESHNESS cursor (`oracleTimestamp` / `oracleOk` /
        // `lastOracleReportAt`) is HELD on the existing values — see
        // OracleReported handler for the dashboard-side rationale
        // (codex P2 #3214513402, PR 1.6).
        if (
          !withThreshold.tokenDecimalsKnown &&
          !isNeverRebalance(withThreshold)
        ) {
          // Preserve the FULL median cursor — timestamp + oracleOk +
          // lastOracleReportAt + tx hash + displayed oraclePrice. Persisting
          // the current event's `oraclePrice` / `oracleTxHash` next to a
          // frozen timestamp would render a misleading row in the oracle
          // tab. codex P2 PR #370 #3214756053.
          context.Pool.set({
            ...withThreshold,
            oracleTimestamp: existing.oracleTimestamp,
            oracleOk: existing.oracleOk,
            // `lastOracleReportAt` is the median freshness anchor used by
            // the indexer-side `derive` path; preserving it too keeps the
            // anchor and the cursor in lockstep until self-heal lands.
            lastOracleReportAt: existing.lastOracleReportAt,
            oracleTxHash: existing.oracleTxHash,
            oraclePrice: existing.oraclePrice,
          });
          return;
        }

        // Preserve existing priceDifference when decimals are untrusted —
        // see OracleReported handler comment block for rationale.
        const decimalsTrustworthy = withThreshold.tokenDecimalsKnown === true;
        const priceDifference = priceDifferenceForOracleSample(
          withThreshold,
          decimalsTrustworthy,
          oraclePrice,
        );
        const degenerateReserves = degenerateReservesForOracleSample(
          withThreshold,
          decimalsTrustworthy,
        );
        const withDev = {
          ...withThreshold,
          priceDifference,
          degenerateReserves,
        };
        const deviationBreachStartedAt = nextDeviationBreachStartedAt(
          existing,
          withDev,
          blockTimestamp,
        );
        const provisional = { ...withDev, deviationBreachStartedAt };
        // Maintain the open-breach denorms here so a median-driven
        // threshold flip (asymmetric pools where reservePrice crosses the
        // oracle and the active side switches) keeps `currentOpenBreachPeak`
        // / `currentOpenBreachEntryThreshold` consistent with the
        // `DeviationThresholdBreach` row that `recordBreachTransition`
        // writes below. `upsertPool` runs the same maintenance on the
        // FPMM-event paths.
        const currentOpenBreachPeak = nextOpenBreachPeak(existing, provisional);
        const currentOpenBreachEntryThreshold = nextOpenBreachEntryThreshold(
          existing,
          provisional,
        );
        const withBreach = {
          ...provisional,
          currentOpenBreachPeak,
          currentOpenBreachEntryThreshold,
        };
        const healthStatus = computeHealthStatus(withBreach, blockTimestamp);
        const finalPool = { ...withBreach, healthStatus };

        const breachPoolUpdate = await recordBreachTransition(
          context,
          existing,
          finalPool,
          {
            blockTimestamp,
            blockNumber,
            txHash: event.transaction.hash,
            logIndex: event.logIndex,
            source: "median_updated",
          },
        );

        // Health score: compute snapshot fields + update pool accumulators.
        const effectiveBps = Number(effectiveThreshold(finalPool));
        const { snapshotFields, poolUpdate } = recordHealthSample(
          finalPool,
          priceDifference,
          effectiveBps,
          blockTimestamp,
          isNeverRebalance(finalPool),
        );
        const merged: Pool = {
          ...finalPool,
          ...poolUpdate,
          ...breachPoolUpdate,
        };
        // `recordHealthSample` may have flipped `hasHealthData: false → true`
        // on the first valid sample. The earlier `computeHealthStatus` call
        // ran against the OLD value (returning `N/A` via the new gate), so
        // `merged.healthStatus` is stale. Recompute against `merged` so the
        // persisted state is consistent (codex P2 PR #370 #3214748736).
        const persistedPool: Pool = {
          ...merged,
          healthStatus: computeHealthStatus(merged, blockTimestamp),
        };
        context.Pool.set(persistedPool);

        const snapshot: OracleSnapshot = {
          id:
            eventId(event.chainId, event.block.number, event.logIndex) +
            `-${poolId}`,
          chainId: event.chainId,
          poolId,
          timestamp: blockTimestamp,
          oraclePrice,
          oracleOk: true,
          numReporters: existing.oracleNumReporters,
          priceDifference,
          degenerateReserves,
          // See OracleReported handler — `persistableThreshold` gates 1e12
          // never-rebalance sentinel out of the `Int!`-typed write.
          rebalanceThreshold: persistableThreshold(finalPool),
          source: "oracle_median_updated",
          blockNumber,
          txHash: event.transaction.hash,
          // Pre-event EMA + effective threshold. See the resolve call above
          // for why this captures the comparator the contract evaluated
          // against, not the post-blend EMA.
          breakerBaselineAtSnapshot:
            breakerSnapshotFields?.breakerBaselineAtSnapshot,
          breakerThresholdAtSnapshot:
            breakerSnapshotFields?.breakerThresholdAtSnapshot,
          ...snapshotFields,
        };
        context.OracleSnapshot.set(snapshot);

        // Refresh the daily snapshot's frozen health counters even when no
        // pool-side activity fires — see the OracleReported handler for why.
        await upsertDailySnapshot({
          context,
          pool: persistedPool,
          blockTimestamp,
          blockNumber,
        });

        // Daily OHLC rollup of the oracle median price — backs the chart's
        // zoomed-out multi-year view (>1000-row Hasura cap on raw medians).
        // Reads from the materialized `snapshot` so any field added upstream is
        // already resolved into it.
        await upsertOraclePriceDaily({
          context,
          chainId: event.chainId,
          poolId,
          blockTimestamp,
          blockNumber,
          oraclePrice: snapshot.oraclePrice,
          oracleOk: snapshot.oracleOk,
          deviationRatio: snapshot.deviationRatio,
          breakerBaselineAtSnapshot: snapshot.breakerBaselineAtSnapshot,
          breakerThresholdAtSnapshot: snapshot.breakerThresholdAtSnapshot,
        });
      }),
    );

    // ----- Breaker EMA + lastMedianRate mirror ----------------------------
    // BreakerBox._checkAndSetBreakers fires from SortedOracles only on median
    // change (this event), so this is the correct hook for EMA mutation —
    // not OracleReported, which fires per-reporter without recomputing EMA.
    // Skip configs that are not enabled (the contract skips them too — see
    // BreakerBox.sol:336-342). For each MedianDelta config, compute the new
    // EMA per the contract's Fixidity formula. ValueDelta keeps the same
    // referenceValue but still gets `lastMedianRate` / `lastUpdatedAt`.
    //
    // We DO mirror zero medians (oracle outage / all reports expired). The
    // dashboard's `computeLiveDelta` treats `lastMedianRate === 0` as "no
    // valid data" and renders the missing-data dash; if we skipped the mirror
    // here, the panel would keep showing the pre-outage value as if it were
    // still live, misleading reset-path triage. The contract itself does not
    // recompute EMA on zero medians (BreakerBox.sol:336-342 only fires on
    // non-zero), so we skip the EMA branch but still write the zero into
    // `lastMedianRate` + bump `lastUpdatedAt`.
    {
      // Already-hydrated set from the earlier eager bootstrap. Cache is
      // in-memory and per-feed, so this is a cheap reuse; the conditional
      // re-bootstrap below remains as a defensive no-op in case future
      // refactors split the two write paths.
      let configsForMirror = breakerConfigsHydrated;
      // Eager bootstrap: for v3 feeds whose breaker config was set entirely
      // before our `start_block`, no later event triggers lazy hydration. On
      // the first MedianUpdated for a feed with zero rows AND at least one
      // indexed pool referencing it, enumerate BreakerBox.getBreakers() and
      // seed the configs. The bootstrap is in-memory-cached per feed so the
      // cost is paid exactly once.
      if (configsForMirror.length === 0 && poolIds.length > 0) {
        await bootstrapFeedBreakerConfigs(
          context,
          event.chainId,
          rateFeedID,
          blockNumber,
          blockTimestamp,
        );
        configsForMirror = await getBreakerConfigsByFeed(
          context,
          event.chainId,
          rateFeedID,
        );
      }
      if (configsForMirror.length > 0) {
        await Promise.all(
          configsForMirror.map(async (cfg) => {
            if (!cfg.enabled) return;
            const breaker = await context.Breaker.get(cfg.breaker_id);
            if (!breaker) return;
            // EMA only recomputes on a positive median (the contract skips
            // zero medians too — BreakerBox.sol:336-342). On a zero median,
            // preserve the existing EMA but still mirror the zero into
            // `lastMedianRate` so the panel renders the missing-data dash.
            const nextEMA =
              breaker.kind === "MEDIAN_DELTA" && oraclePrice > 0n
                ? nextMedianEMA(
                    oraclePrice,
                    cfg.medianRatesEMA ?? 0n,
                    cfg.smoothingFactor ?? 0n,
                  )
                : cfg.medianRatesEMA;
            // Skip the write only when ALL three fields would be unchanged — same
            // median, same EMA, AND same `lastUpdatedAt`. Distinct MedianUpdated
            // events always carry distinct block timestamps, so the optimization
            // here only kicks in for same-block event replay during preload. We
            // must include `lastUpdatedAt` in the comparison so that a repeated
            // median value (oracle reports that round to the same rate) still
            // refreshes the "last seen" timestamp.
            if (
              cfg.lastMedianRate === oraclePrice &&
              cfg.medianRatesEMA === nextEMA &&
              cfg.lastUpdatedAt === blockTimestamp
            ) {
              return;
            }
            context.BreakerConfig.set({
              ...cfg,
              lastMedianRate: oraclePrice,
              lastUpdatedAt: blockTimestamp,
              medianRatesEMA: nextEMA,
            });
          }),
        );
      }
    }
  },
);

// ---------------------------------------------------------------------------
// SortedOracles.TokenReportExpirySet
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "SortedOracles", event: "TokenReportExpirySet" },
  async ({ event, context }) => {
    const rateFeedID = asAddress(event.params.token);
    const poolIds = await getPoolsByFeed(context, event.chainId, rateFeedID);
    // See OracleReported handler.
    if (await maybePreloadPool(context, poolIds)) return;
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    const oracleExpiry = await context.effect(reportExpiryEffect, {
      chainId: event.chainId,
      rateFeedID,
      blockNumber,
    });

    await updatePoolsOracleExpiry(
      context,
      poolIds,
      oracleExpiry,
      blockNumber,
      blockTimestamp,
    );
  },
);

// ---------------------------------------------------------------------------
// SortedOracles.ReportExpirySet
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "SortedOracles", event: "ReportExpirySet" },
  async ({ event, context }) => {
    const pools = await getPoolsWithReferenceFeed(context, event.chainId);
    // See OracleReported handler.
    if (
      await maybePreloadPool(
        context,
        pools.map((p) => p.id),
      )
    )
      return;
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    await Promise.all(
      pools.map(async (pool) => {
        const oracleExpiry = await context.effect(reportExpiryEffect, {
          chainId: event.chainId,
          rateFeedID: pool.referenceRateFeedID,
          blockNumber,
        });
        await updatePoolsOracleExpiry(
          context,
          [pool.id],
          oracleExpiry,
          blockNumber,
          blockTimestamp,
        );
      }),
    );
  },
);
