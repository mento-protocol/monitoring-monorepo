// ---------------------------------------------------------------------------
// BreakerBox event handlers
//
// BreakerBox orchestrates the per-(rateFeed, breaker) trip/reset state. It
// emits events when:
//   - a Breaker is added/removed (lifecycle)
//   - a Breaker is enabled/disabled for a specific feed
//   - a Breaker trips for a feed (BreakerTripped)
//   - a feed's tripped breakers are reset (ResetSuccessful)
//   - the owner manually overrides trading mode (TradingModeUpdated)
//
// The MedianDelta and ValueDelta breakers themselves emit per-feed config
// updates (cooldown / threshold / EMA-related) — handled in
// medianDeltaBreaker.ts and valueDeltaBreaker.ts. EMA mirroring on each
// `MedianUpdated` lives in sortedOracles.ts.
// ---------------------------------------------------------------------------

import type { BreakerConfig, BreakerTripEvent } from "envio";
import { indexer } from "../indexer.js";
import { eventId, asAddress, asBigInt } from "../helpers.js";
import {
  bootstrapFeedBreakerConfigs,
  computeCooldownEndsAt,
  effectiveCooldown,
  effectiveThreshold,
  ensureBreaker,
  ensureBreakerConfig,
  makeBreakerId,
  maybePreloadBreaker,
  syncPoolsBreakerHalt,
} from "../breakers.js";

// ---------------------------------------------------------------------------
// BreakerBox.BreakerAdded — lifecycle: a new breaker contract is registered.
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "BreakerBox", event: "BreakerAdded" },
  async ({ event, context }) => {
    const breakerAddress = asAddress(event.params.breaker);
    const breakerId = makeBreakerId(event.chainId, breakerAddress);
    if (await maybePreloadBreaker(context, breakerId)) return;
    await ensureBreaker(
      context,
      event.chainId,
      breakerAddress,
      asBigInt(event.block.number),
      asBigInt(event.block.timestamp),
    );
  },
);

// ---------------------------------------------------------------------------
// BreakerBox.BreakerRemoved — mark removed, disable all child configs.
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "BreakerBox", event: "BreakerRemoved" },
  async ({ event, context }) => {
    const breakerAddress = asAddress(event.params.breaker);
    const breakerId = makeBreakerId(event.chainId, breakerAddress);
    if (await maybePreloadBreaker(context, breakerId)) return;
    const existing = await context.Breaker.get(breakerId);
    if (existing) {
      context.Breaker.set({ ...existing, removed: true });
    }
    // Disable any existing per-feed configs on the same chain. Per-feed rows
    // we discover later (RPC self-heal on a new event) will see the breaker
    // already marked removed and skip self-heal.
    const configs = await context.BreakerConfig.getWhere({
      breakerAddress: { _eq: breakerAddress },
    });
    // A breaker can serve multiple feeds; disabling it may clear the halt OR
    // on any of them, so collect the touched feeds and re-sync each.
    const affectedFeeds = new Set<string>();
    for (const cfg of configs) {
      if (cfg.chainId === event.chainId && cfg.enabled) {
        context.BreakerConfig.set({ ...cfg, enabled: false });
        affectedFeeds.add(cfg.rateFeedID);
      }
    }
    for (const feed of affectedFeeds) {
      await syncPoolsBreakerHalt(context, event.chainId, feed);
    }
  },
);

// ---------------------------------------------------------------------------
// BreakerBox.BreakerStatusUpdated — owner toggled a breaker for a feed.
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "BreakerBox", event: "BreakerStatusUpdated" },
  async ({ event, context }) => {
    const breakerAddress = asAddress(event.params.breaker);
    const rateFeedID = asAddress(event.params.rateFeedID);
    const enabled = Boolean(event.params.status);

    const breakerId = makeBreakerId(event.chainId, breakerAddress);
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    if (await maybePreloadBreaker(context, breakerId)) return;

    const breaker = await ensureBreaker(
      context,
      event.chainId,
      breakerAddress,
      blockNumber,
      blockTimestamp,
    );
    if (!breaker) return;

    const cfg = await ensureBreakerConfig(
      context,
      event.chainId,
      breaker,
      rateFeedID,
      blockNumber,
    );
    if (!cfg) return;

    if (cfg.enabled !== enabled) {
      context.BreakerConfig.set({ ...cfg, enabled });
      // Enabling/disabling a breaker can flip the feed's halt OR.
      await syncPoolsBreakerHalt(context, event.chainId, rateFeedID);
    }
  },
);

// ---------------------------------------------------------------------------
// BreakerBox.RateFeedAdded / RateFeedRemoved — BreakerBox-level metadata.
// We don't write entity rows for these: per-feed BreakerConfig rows are
// created on the first BreakerStatusUpdated for the feed.
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "BreakerBox", event: "RateFeedAdded" },
  async () => {
    // No-op.
  },
);

indexer.onEvent(
  { contract: "BreakerBox", event: "RateFeedRemoved" },
  async () => {
    // No-op. Existing BreakerConfig rows for the removed feed remain as
    // historical record; they'll never receive new events.
  },
);

// ---------------------------------------------------------------------------
// BreakerBox.BreakerTripped — emit BreakerTripEvent + transition BreakerConfig.
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "BreakerBox", event: "BreakerTripped" },
  async ({ event, context }) => {
    const breakerAddress = asAddress(event.params.breaker);
    const rateFeedID = asAddress(event.params.rateFeedID);

    const breakerId = makeBreakerId(event.chainId, breakerAddress);
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    if (await maybePreloadBreaker(context, breakerId)) return;

    const breaker = await ensureBreaker(
      context,
      event.chainId,
      breakerAddress,
      blockNumber,
      blockTimestamp,
    );
    if (!breaker) return;

    const cfg = await ensureBreakerConfig(
      context,
      event.chainId,
      breaker,
      rateFeedID,
      blockNumber,
    );
    if (!cfg) return;

    const cooldown = effectiveCooldown(breaker, cfg.cooldownTime);
    const referenceAtTrip =
      breaker.kind === "MEDIAN_DELTA" ? cfg.medianRatesEMA : cfg.referenceValue;

    const tripEvent: BreakerTripEvent = {
      id: eventId(event.chainId, event.block.number, event.logIndex),
      chainId: event.chainId,
      breaker_id: breaker.id,
      breakerAddress: breaker.address,
      rateFeedID,
      blockNumber,
      blockTimestamp,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      medianRateAtTrip: cfg.lastMedianRate ?? 0n,
      referenceAtTrip,
      // Resolve sentinel `0` to the breaker default so historical trip data
      // captures the threshold that ACTUALLY caused the trip (not the
      // inherit-marker). Mirrors the effectiveCooldown call two lines above.
      thresholdAtTrip: effectiveThreshold(breaker, cfg.rateChangeThreshold),
    };
    context.BreakerTripEvent.set(tripEvent);

    const updated: BreakerConfig = {
      ...cfg,
      status: "TRIPPED",
      tradingMode: breaker.activatesTradingMode,
      lastStatusUpdatedAt: blockTimestamp,
      cooldownEndsAt: computeCooldownEndsAt(blockTimestamp, cooldown),
      lastTripAt: blockTimestamp,
      lastTripTxHash: event.transaction.hash,
      tripCountLifetime: cfg.tripCountLifetime + 1,
    };
    context.BreakerConfig.set(updated);

    // Reflect the halt onto every pool on this feed (price breakers only;
    // MARKET_HOURS is excluded inside the helper).
    await syncPoolsBreakerHalt(context, event.chainId, rateFeedID);
  },
);

// ---------------------------------------------------------------------------
// BreakerBox.ResetSuccessful — breaker auto-reset on next oracle report.
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "BreakerBox", event: "ResetSuccessful" },
  async ({ event, context }) => {
    const breakerAddress = asAddress(event.params.breaker);
    const rateFeedID = asAddress(event.params.rateFeedID);

    const breakerId = makeBreakerId(event.chainId, breakerAddress);
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    if (await maybePreloadBreaker(context, breakerId)) return;

    const breaker = await ensureBreaker(
      context,
      event.chainId,
      breakerAddress,
      blockNumber,
      blockTimestamp,
    );
    if (!breaker) return;

    const cfg = await ensureBreakerConfig(
      context,
      event.chainId,
      breaker,
      rateFeedID,
      blockNumber,
    );
    if (!cfg) return;

    const cooldown = effectiveCooldown(breaker, cfg.cooldownTime);
    context.BreakerConfig.set({
      ...cfg,
      status: "OK",
      tradingMode: 0,
      lastStatusUpdatedAt: blockTimestamp,
      cooldownEndsAt: computeCooldownEndsAt(blockTimestamp, cooldown),
      lastResetAt: blockTimestamp,
    });

    // Clearing the trip may lift the feed's halt — re-sync the pools.
    await syncPoolsBreakerHalt(context, event.chainId, rateFeedID);
  },
);

// ---------------------------------------------------------------------------
// BreakerBox.TradingModeUpdated — owner manually overrode the feed's mode.
// Fires from `setRateFeedTradingMode` (BreakerBox.sol:241). Does NOT fire
// from `_checkAndSetBreakers` auto-recompute, so we treat it as an authoritative
// override across all of the feed's enabled BreakerConfig rows on this chain.
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "BreakerBox", event: "TradingModeUpdated" },
  async ({ event, context }) => {
    // Feed-scoped event — there is no single breaker-id to preload, so just
    // bail during the preload phase. Mirrors the explicit `if (isPreload) return;`
    // guard the other BreakerBox handlers get for free via maybePreloadBreaker.
    if (context.isPreload) return;

    const rateFeedID = asAddress(event.params.rateFeedID);
    const tradingMode = Number(event.params.tradingMode);
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    await bootstrapFeedBreakerConfigs(
      context,
      event.chainId,
      rateFeedID,
      blockNumber,
      blockTimestamp,
    );

    // Multi-row update — fan-out across this feed's ENABLED configs on this
    // chain. Disabled configs are skipped: a governance-disabled breaker is
    // not authoritative for trading-mode decisions, and writing TRIPPED to a
    // disabled row corrupts per-breaker state for downstream UI reads (and any
    // future feed with multiple breakers). We bump `lastStatusUpdatedAt` here,
    // so we MUST also recompute `cooldownEndsAt` (the pre-rolled
    // `lastStatusUpdatedAt + cooldownTime`) — otherwise the dashboard's
    // countdown would render against the previous trip/reset's timestamp and
    // immediately show as expired.
    const configs = await context.BreakerConfig.getWhere({
      rateFeedID: { _eq: rateFeedID },
    });
    for (const cfg of configs) {
      if (cfg.chainId !== event.chainId) continue;
      if (!cfg.enabled) continue;
      if (cfg.tradingMode === tradingMode) continue;
      const breaker = await context.Breaker.get(cfg.breaker_id);
      const cooldown = breaker
        ? effectiveCooldown(breaker, cfg.cooldownTime)
        : cfg.cooldownTime;
      context.BreakerConfig.set({
        ...cfg,
        tradingMode,
        status: tradingMode === 0 ? "OK" : "TRIPPED",
        lastStatusUpdatedAt: blockTimestamp,
        cooldownEndsAt: computeCooldownEndsAt(blockTimestamp, cooldown),
      });
    }

    // Manual override touched every enabled config on the feed — re-sync once.
    await syncPoolsBreakerHalt(context, event.chainId, rateFeedID);
  },
);
