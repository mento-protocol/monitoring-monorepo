// ---------------------------------------------------------------------------
// Breaker handler helpers — entity ID composition, upsert, RPC self-heal.
//
// The on-chain BreakerBox + MedianDelta + ValueDelta were deployed before our
// indexer's `start_block` on both chains, so initial config events (BreakerAdded,
// BreakerStatusUpdated, RateChangeThresholdUpdated, etc.) are not in our event
// stream. On the first event for any (breaker, feed) pair we don't yet know,
// hydrate from RPC via `fetchBreakerDefaults` / `fetchBreakerFeedState`.
// ---------------------------------------------------------------------------

import type { Breaker, BreakerConfig, Pool, RateFeedDependency } from "envio";
import type { EvmOnEventContext } from "envio";
import { asAddress, isVirtualPool } from "./helpers.js";
import { getPoolsByFeed, type BreakerKindRpc } from "./rpc.js";
import {
  breakerDefaultsEffect,
  breakerFeedStateEffect,
  breakerKindEffect,
  breakerListEffect,
  rateFeedDependenciesEffect,
} from "./rpc/effects.js";

/** ID for the per-breaker `Breaker` entity. */
export function makeBreakerId(chainId: number, breakerAddress: string): string {
  return `${chainId}-${asAddress(breakerAddress)}`;
}

/** ID for the per-(breaker, feed) `BreakerConfig` entity. */
export function makeBreakerConfigId(
  chainId: number,
  breakerAddress: string,
  rateFeedID: string,
): string {
  return `${chainId}-${asAddress(breakerAddress)}-${asAddress(rateFeedID)}`;
}

/** Refresh `cooldownEndsAt = lastStatusUpdatedAt + cooldownTime`. Pre-rolling
 * this lets the dashboard render the countdown without RPC. Refresh on every
 * cooldown / status change. */
export function computeCooldownEndsAt(
  lastStatusUpdatedAt: bigint,
  cooldownTime: bigint,
): bigint {
  if (cooldownTime <= 0n) return 0n;
  return lastStatusUpdatedAt + cooldownTime;
}

/** Preload-phase hook for breaker handlers. Mirrors `maybePreloadPool` —
 * during Envio's preload phase, warm the entity caches and bail before any
 * RPC fires. Processing phase then runs with consistent in-batch state. */
export async function maybePreloadBreaker(
  context: {
    isPreload: boolean;
    Breaker: { get: (id: string) => Promise<Breaker | undefined> };
    BreakerConfig?: {
      get: (id: string) => Promise<BreakerConfig | undefined>;
    };
  },
  breakerId: string,
  configId?: string,
): Promise<boolean> {
  if (!context.isPreload) return false;
  await context.Breaker.get(breakerId);
  if (configId && context.BreakerConfig) {
    await context.BreakerConfig.get(configId);
  }
  return true;
}

/** Read or RPC-bootstrap the `Breaker` entity for `(chainId, breakerAddress)`.
 * Caller passes the event block number (used as the bootstrap block). */
export async function ensureBreaker(
  context: EvmOnEventContext,
  chainId: number,
  breakerAddress: string,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<Breaker | null> {
  const id = makeBreakerId(chainId, breakerAddress);
  const existing = await context.Breaker.get(id);
  if (existing) return existing;

  // breakerKindEffect returns null on transient RPC failure so we
  // don't poison the kind (e.g. persisting MARKET_HOURS for a real
  // MedianDelta breaker just because a single probe call timed out).
  // Bail and let the next event retry.
  const kind = await context.effect(breakerKindEffect, {
    chainId,
    breakerAddress,
  });
  if (!kind) return null;
  const defaults = await context.effect(breakerDefaultsEffect, {
    chainId,
    breakerAddress,
    kind,
    blockNumber,
  });
  if (!defaults) return null;

  const breaker: Breaker = {
    id,
    chainId,
    address: asAddress(breakerAddress),
    // The effect outputs `string` (BreakerKindRpc rides as S.string); cast
    // back to the typed union before persisting to the entity.
    kind: kind as BreakerKindRpc,
    activatesTradingMode: defaults.activatesTradingMode,
    defaultCooldownTime: defaults.defaultCooldownTime,
    defaultRateChangeThreshold: defaults.defaultRateChangeThreshold,
    registeredAtBlock: blockNumber,
    registeredAtTimestamp: blockTimestamp,
    removed: false,
  };
  context.Breaker.set(breaker);
  return breaker;
}

/** Read or RPC-bootstrap the `BreakerConfig` entity for
 * `(chainId, breakerAddress, rateFeedID)`. Always refreshes `cooldownEndsAt`
 * from the loaded state. Returns null if RPC bootstrap fails. */
export async function ensureBreakerConfig(
  context: EvmOnEventContext,
  chainId: number,
  breaker: Breaker,
  rateFeedID: string,
  blockNumber: bigint,
): Promise<BreakerConfig | null> {
  const id = makeBreakerConfigId(chainId, breaker.address, rateFeedID);
  const existing = await context.BreakerConfig.get(id);
  if (existing) return existing;

  const state = await context.effect(breakerFeedStateEffect, {
    chainId,
    breakerAddress: breaker.address,
    kind: breaker.kind as BreakerKindRpc,
    rateFeedID,
    blockNumber,
  });
  if (!state) return null;

  const cfg: BreakerConfig = {
    id,
    chainId,
    breaker_id: breaker.id,
    breakerAddress: breaker.address,
    rateFeedID: asAddress(rateFeedID),
    enabled: state.enabled,
    cooldownTime: state.cooldownTime,
    rateChangeThreshold: state.rateChangeThreshold,
    smoothingFactor: state.smoothingFactor ?? undefined,
    medianRatesEMA: state.medianRatesEMA ?? undefined,
    referenceValue: state.referenceValue ?? undefined,
    lastMedianRate: undefined,
    lastUpdatedAt: undefined,
    status: state.tradingMode === 0 ? "OK" : "TRIPPED",
    tradingMode: state.tradingMode,
    lastStatusUpdatedAt: state.lastStatusUpdatedAt,
    cooldownEndsAt: computeCooldownEndsAt(
      state.lastStatusUpdatedAt,
      effectiveCooldown(breaker, state.cooldownTime),
    ),
    lastTripAt: undefined,
    lastTripTxHash: undefined,
    lastResetAt: undefined,
    tripCountLifetime: 0,
  };
  context.BreakerConfig.set(cfg);
  return cfg;
}

/** Eager bootstrap path: many feeds had their breaker config set BEFORE our
 * `start_block`, so no event ever fires post-start to trigger lazy hydration.
 * On the first MedianUpdated for a feed with zero BreakerConfig rows, enumerate
 * the BreakerBox's registered breakers via RPC and bootstrap a config row for
 * each one. Bounded by an in-memory cache so we attempt only once per
 * (chainId, rateFeedID) per process — the cost is one extra
 * `BreakerBox.getBreakers()` call + a handful of `ensureBreakerConfig` calls
 * per feed, paid exactly once. Soft-capped with FIFO eviction so the cache
 * can't grow without bound if a hostile feed registers many distinct
 * rateFeedIDs (mirrors the `REBALANCING_STATE_CACHE_MAX` pattern in rpc.ts). */
const BOOTSTRAP_ATTEMPTED_MAX = 1024;
const _bootstrapAttempted = new Set<string>();

/** Negative cache: chain-time TTL after a `breakerListEffect` failure. The
 * "transient failure → never mark attempted" design loops cleanly when the
 * RPC actually is transient, but persistently-broken providers (observed:
 * Monad RPCs without full archive depth back to `start_block`) fire one
 * `getBreakers()` call per `MedianUpdated` event during catch-up. With no
 * effect-level dedup across blocks, that compounds into thousands of
 * wasted calls per hour. Capping retries to once per N seconds of CHAIN
 * time (not wall-clock) bounds the storm without giving up the eventual
 * recovery path.
 *
 * Soft-capped with FIFO eviction at the same `BOOTSTRAP_ATTEMPTED_MAX`
 * cap as `_bootstrapAttempted` — a hostile feed that registers many
 * distinct rateFeedIDs while the upstream RPC is broken would otherwise
 * grow this map unboundedly. Eviction matches the success-cache pattern;
 * markBootstrapAttempted's eviction also drops the paired backoff entry
 * so the two caches don't drift. */
const BOOTSTRAP_BACKOFF_SECONDS = 5n * 60n;
const _bootstrapBackoffUntilTs = new Map<string, bigint>();

/** @internal Test-only: clear both bootstrap caches between tests. */
export function _clearBootstrapCaches(): void {
  _bootstrapAttempted.clear();
  _bootstrapBackoffUntilTs.clear();
}

export async function bootstrapFeedBreakerConfigs(
  context: EvmOnEventContext,
  chainId: number,
  rateFeedID: string,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<void> {
  const cacheKey = `${chainId}:${rateFeedID.toLowerCase()}`;
  if (_bootstrapAttempted.has(cacheKey)) return;
  // Skip retry while inside the negative-cache TTL window.
  const backoffUntil = _bootstrapBackoffUntilTs.get(cacheKey);
  if (backoffUntil !== undefined && blockTimestamp < backoffUntil) return;

  // Only mark as attempted AFTER a successful BreakerBox.getBreakers() call.
  // A transient RPC failure here would otherwise permanently poison the
  // cache for the rest of the process — and for feeds whose breaker setup
  // happened before `start_block`, this is the only hydration path, so a
  // brief network blip would leave breaker state missing until restart.
  // Persistent failures land in the negative-cache TTL above instead.
  const breakerAddresses = await context.effect(breakerListEffect, {
    chainId,
    blockNumber,
  });
  if (!breakerAddresses) {
    setBootstrapBackoff(cacheKey, blockTimestamp + BOOTSTRAP_BACKOFF_SECONDS);
    return;
  }
  if (breakerAddresses.length === 0) {
    // Empty list is itself authoritative (no breakers registered for this
    // BreakerBox at this block) — safe to cache so we don't refetch.
    markBootstrapAttempted(cacheKey);
    _bootstrapBackoffUntilTs.delete(cacheKey);
    return;
  }

  // Track whether every per-breaker hydration call succeeded. A null return
  // from `ensureBreaker` or `ensureBreakerConfig` means the underlying RPC
  // call failed mid-bootstrap — we MUST NOT cache the feed in that case, or
  // the failed breaker stays unhydrated until process restart. The next
  // event re-runs bootstrap; rows already written are idempotent.
  let allSucceeded = true;
  for (const breakerAddress of breakerAddresses) {
    const breaker = await ensureBreaker(
      context,
      chainId,
      breakerAddress,
      blockNumber,
      blockTimestamp,
    );
    if (!breaker) {
      allSucceeded = false;
      continue;
    }
    const cfg = await ensureBreakerConfig(
      context,
      chainId,
      breaker,
      rateFeedID,
      blockNumber,
    );
    if (!cfg) allSucceeded = false;
  }

  if (allSucceeded) {
    markBootstrapAttempted(cacheKey);
    _bootstrapBackoffUntilTs.delete(cacheKey);
  } else {
    setBootstrapBackoff(cacheKey, blockTimestamp + BOOTSTRAP_BACKOFF_SECONDS);
  }
}

/** Set a backoff TTL for a (chain, feed) tuple, applying FIFO eviction at
 * the same `BOOTSTRAP_ATTEMPTED_MAX` cap so the two caches grow together.
 * Map preserves insertion order, so `keys().next().value` is the oldest. */
function setBootstrapBackoff(cacheKey: string, untilTs: bigint): void {
  if (
    _bootstrapBackoffUntilTs.size >= BOOTSTRAP_ATTEMPTED_MAX &&
    !_bootstrapBackoffUntilTs.has(cacheKey)
  ) {
    const oldest = _bootstrapBackoffUntilTs.keys().next().value;
    if (oldest !== undefined) _bootstrapBackoffUntilTs.delete(oldest);
  }
  _bootstrapBackoffUntilTs.set(cacheKey, untilTs);
}

/** Add a feed to the bootstrap-attempted cache, applying FIFO eviction when
 * we're at the soft cap. Sets preserve insertion order so we drop the oldest
 * entry; the evicted feed's next event simply re-bootstraps (idempotent).
 * Paired backoff entry is dropped on eviction so the two caches stay in sync. */
function markBootstrapAttempted(cacheKey: string): void {
  if (
    _bootstrapAttempted.size >= BOOTSTRAP_ATTEMPTED_MAX &&
    !_bootstrapAttempted.has(cacheKey)
  ) {
    const oldest = _bootstrapAttempted.values().next().value;
    if (oldest !== undefined) {
      _bootstrapAttempted.delete(oldest);
      _bootstrapBackoffUntilTs.delete(oldest);
    }
  }
  _bootstrapAttempted.add(cacheKey);
}

/** Per-feed cooldown overrides the breaker default; sentinel 0 = inherit. */
export function effectiveCooldown(
  breaker: Pick<Breaker, "defaultCooldownTime">,
  perFeedCooldown: bigint,
): bigint {
  return perFeedCooldown > 0n ? perFeedCooldown : breaker.defaultCooldownTime;
}

/** Per-feed threshold overrides the breaker default; sentinel 0 = inherit. */
export function effectiveThreshold(
  breaker: Pick<Breaker, "defaultRateChangeThreshold">,
  perFeedThreshold: bigint,
): bigint {
  return perFeedThreshold > 0n
    ? perFeedThreshold
    : breaker.defaultRateChangeThreshold;
}

/** Reads BreakerConfig + Breaker for the given (chainId, rateFeedID) and
 * returns the per-snapshot baseline + effective threshold to persist on an
 * `OracleSnapshot` row. The chart consumer reads these to render a per-point
 * "would have tripped at the time" verdict instead of comparing every
 * historical point against the current EMA (which drifts on MEDIAN_DELTA
 * feeds — see PR #624 follow-up).
 *
 * Selection rules — match the dashboard's `BREAKER_CONFIG_FOR_RATE_FEED`
 * query so historical + current verdicts stay in sync:
 *   - exclude MARKET_HOURS (schedule halt, not a deviation comparator)
 *   - only `enabled` configs
 *   - deterministic pick when a feed has multiple matches (sort by id asc).
 *
 * Returns null when:
 *   - no trip-able config exists for the feed,
 *   - the referenced Breaker entity isn't loaded yet (bootstrap race),
 *   - MEDIAN_DELTA baseline is the `0n` "unseeded" sentinel
 *     (see BreakerConfig.medianRatesEMA doc; treating it as `baseline = 0`
 *     would corrupt the chart's verdict math),
 *   - VALUE_DELTA `referenceValue` is null (breaker not yet configured).
 */
/**
 * Bootstrap (if BreakerBox events predate start_block) + resolve in one
 * call. Used by both OracleReported and MedianUpdated handlers — without
 * the conditional bootstrap, the very first event for a feed whose
 * `BreakerAdded` predates start_block resolves to null and persists null
 * historical-band fields forever after.
 */
export async function bootstrapAndResolveBreakerSnapshotFields(args: {
  context: EvmOnEventContext;
  chainId: number;
  rateFeedID: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
  knownConfigsLength: number;
  poolsLength: number;
}): Promise<{
  breakerBaselineAtSnapshot: bigint;
  breakerThresholdAtSnapshot: bigint;
} | null> {
  const {
    context,
    chainId,
    rateFeedID,
    blockNumber,
    blockTimestamp,
    knownConfigsLength,
    poolsLength,
  } = args;
  if (knownConfigsLength === 0 && poolsLength > 0) {
    await bootstrapFeedBreakerConfigs(
      context,
      chainId,
      rateFeedID,
      blockNumber,
      blockTimestamp,
    );
  }
  return resolveBreakerSnapshotFields(context, chainId, rateFeedID);
}

export async function resolveBreakerSnapshotFields(
  context: EvmOnEventContext,
  chainId: number,
  rateFeedID: string,
): Promise<{
  breakerBaselineAtSnapshot: bigint;
  breakerThresholdAtSnapshot: bigint;
} | null> {
  // Same chainId-in-memory filter rationale as `getBreakerConfigsByFeed`.
  const configs = await context.BreakerConfig.getWhere({
    rateFeedID: { _eq: rateFeedID },
  });
  // Filter to trip-able configs (excludes MARKET_HOURS, disabled) +
  // resolve the linked Breaker. We need the Breaker so we can resolve the
  // sentinel-0 threshold to its inherited default. Bounded fan-out: ≤1
  // trip-able config per feed in production.
  let selected: {
    cfg: BreakerConfig;
    breaker: Breaker;
    kind: BreakerKindRpc;
  } | null = null;
  // Sort for deterministic pick when (rare) multiple trip-ables exist.
  const sortedConfigs = [...configs]
    .filter((c) => c.chainId === chainId && c.enabled)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const cfg of sortedConfigs) {
    const breaker = await context.Breaker.get(cfg.breaker_id);
    if (!breaker) continue;
    if (breaker.kind === "MARKET_HOURS") continue;
    selected = { cfg, breaker, kind: breaker.kind };
    break;
  }
  if (!selected) return null;
  const { cfg, breaker, kind } = selected;
  const baseline =
    kind === "VALUE_DELTA" ? cfg.referenceValue : cfg.medianRatesEMA;
  // 0n EMA = MedianRateEMAReset's unseeded sentinel; null referenceValue =
  // VALUE_DELTA not configured. Either way the breaker has no usable
  // comparator, so don't persist a misleading baseline.
  if (baseline == null || baseline === 0n) return null;
  return {
    breakerBaselineAtSnapshot: baseline,
    breakerThresholdAtSnapshot: effectiveThreshold(
      breaker,
      cfg.rateChangeThreshold,
    ),
  };
}

/** Refresh `BreakerConfig.cooldownEndsAt` after a cooldown-related field
 * change. The pre-rolled `cooldownEndsAt = lastStatusUpdatedAt +
 * cooldownTime` formula uses the EFFECTIVE cooldown (per-feed override else
 * breaker default), so any of those three values changing requires a rerun. */
export async function refreshCooldownEndsAt(
  context: EvmOnEventContext,
  cfg: BreakerConfig,
): Promise<BreakerConfig> {
  const breaker = await context.Breaker.get(cfg.breaker_id);
  if (!breaker) return cfg;
  const cd = effectiveCooldown(breaker, cfg.cooldownTime);
  const nextEnds = computeCooldownEndsAt(cfg.lastStatusUpdatedAt, cd);
  if (nextEnds === cfg.cooldownEndsAt) return cfg;
  const updated = { ...cfg, cooldownEndsAt: nextEnds };
  context.BreakerConfig.set(updated);
  return updated;
}

/** When a Breaker's `defaultCooldownTime` changes, every BreakerConfig that
 * inherits it (perFeedCooldown == 0) needs `cooldownEndsAt` recomputed.
 * Bounded fan-out: handful of feeds per breaker. */
export async function refreshAllInheritingCooldowns(
  context: EvmOnEventContext,
  breaker: Breaker,
): Promise<void> {
  const configs = await context.BreakerConfig.getWhere({
    breakerAddress: { _eq: breaker.address },
  });
  for (const cfg of configs) {
    if (cfg.chainId !== breaker.chainId) continue;
    if (cfg.cooldownTime > 0n) continue; // per-feed override, not affected by default change
    const nextEnds = computeCooldownEndsAt(
      cfg.lastStatusUpdatedAt,
      breaker.defaultCooldownTime,
    );
    if (nextEnds !== cfg.cooldownEndsAt) {
      context.BreakerConfig.set({ ...cfg, cooldownEndsAt: nextEnds });
    }
  }
}

/** Compute the next EMA value from current median + previous EMA + smoothing
 * factor. Mirrors MedianDeltaBreaker.shouldTrigger:
 *   newEMA = sf * currentMedian + (1 - sf) * previousEMA   (Fixidity 1e24=100%)
 * If `previousEMA == 0`, this is the seed branch — return `currentMedian`
 * unchanged (matches contract behavior at line 182 of MedianDeltaBreaker.sol). */
export function nextMedianEMA(
  currentMedian: bigint,
  previousEMA: bigint,
  smoothingFactor: bigint,
): bigint {
  if (previousEMA === 0n) return currentMedian;
  const FIXED_1 = 10n ** 24n;
  const sf = smoothingFactor > 0n ? smoothingFactor : FIXED_1; // default smoothing
  // Use the same Fixidity arithmetic as the contract: scaled mul-add then divide.
  return (currentMedian * sf + previousEMA * (FIXED_1 - sf)) / FIXED_1;
}

// ---------------------------------------------------------------------------
// Shared per-breaker config event handlers
//
// MedianDeltaBreaker and ValueDeltaBreaker share an identical event surface
// for cooldown + threshold updates (both inherit WithCooldown + WithThreshold
// in mento-core). The four handlers below are registered against both
// contracts in handlers/medianDeltaBreaker.ts and handlers/valueDeltaBreaker.ts.
// Kind-specific events (SmoothingFactorSet, MedianRateEMAReset, ReferenceValueUpdated)
// stay in their per-contract files.
// ---------------------------------------------------------------------------

type ChainEvent = {
  chainId: number;
  srcAddress: string;
  block: { number: number | bigint; timestamp: number | bigint };
};

type DefaultCooldownEvent = ChainEvent & {
  params: { newCooldownTime: bigint };
};
type DefaultThresholdEvent = ChainEvent & {
  params: { defaultRateChangeThreshold: bigint };
};
type RateFeedCooldownEvent = ChainEvent & {
  params: { rateFeedID: string; newCooldownTime: bigint };
};
type RateFeedThresholdEvent = ChainEvent & {
  params: { rateFeedID: string; rateChangeThreshold: bigint };
};

export async function handleDefaultCooldownTimeUpdated({
  event,
  context,
}: {
  event: DefaultCooldownEvent;
  context: EvmOnEventContext;
}): Promise<void> {
  const breakerAddress = asAddress(event.srcAddress);
  const breakerId = makeBreakerId(event.chainId, breakerAddress);
  if (await maybePreloadBreaker(context, breakerId)) return;

  const breaker = await ensureBreaker(
    context,
    event.chainId,
    breakerAddress,
    BigInt(event.block.number),
    BigInt(event.block.timestamp),
  );
  if (!breaker) return;

  const newDefault = event.params.newCooldownTime;
  if (breaker.defaultCooldownTime === newDefault) return;
  const updated = { ...breaker, defaultCooldownTime: newDefault };
  context.Breaker.set(updated);
  await refreshAllInheritingCooldowns(context, updated);
}

export async function handleDefaultRateChangeThresholdUpdated({
  event,
  context,
}: {
  event: DefaultThresholdEvent;
  context: EvmOnEventContext;
}): Promise<void> {
  const breakerAddress = asAddress(event.srcAddress);
  const breakerId = makeBreakerId(event.chainId, breakerAddress);
  if (await maybePreloadBreaker(context, breakerId)) return;

  const breaker = await ensureBreaker(
    context,
    event.chainId,
    breakerAddress,
    BigInt(event.block.number),
    BigInt(event.block.timestamp),
  );
  if (!breaker) return;

  const newDefault = event.params.defaultRateChangeThreshold;
  if (breaker.defaultRateChangeThreshold === newDefault) return;
  context.Breaker.set({ ...breaker, defaultRateChangeThreshold: newDefault });
}

export async function handleRateFeedCooldownTimeUpdated({
  event,
  context,
}: {
  event: RateFeedCooldownEvent;
  context: EvmOnEventContext;
}): Promise<void> {
  const breakerAddress = asAddress(event.srcAddress);
  const rateFeedID = asAddress(event.params.rateFeedID);
  const breakerId = makeBreakerId(event.chainId, breakerAddress);
  const blockNumber = BigInt(event.block.number);
  const blockTimestamp = BigInt(event.block.timestamp);

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

  const newCooldown = event.params.newCooldownTime;
  if (cfg.cooldownTime === newCooldown) return;
  // Persist the cooldownTime field DIRECTLY here. `refreshCooldownEndsAt`
  // skips writes when the *effective* cooldown is unchanged (e.g. switching
  // between sentinel-0 and the breaker default), but the per-feed override
  // value must still round-trip to the schema regardless. Then refresh the
  // pre-rolled cooldownEndsAt to reflect the new override.
  const updated = { ...cfg, cooldownTime: newCooldown };
  context.BreakerConfig.set(updated);
  await refreshCooldownEndsAt(context, updated);
}

export async function handleRateChangeThresholdUpdated({
  event,
  context,
}: {
  event: RateFeedThresholdEvent;
  context: EvmOnEventContext;
}): Promise<void> {
  const breakerAddress = asAddress(event.srcAddress);
  const rateFeedID = asAddress(event.params.rateFeedID);
  const breakerId = makeBreakerId(event.chainId, breakerAddress);
  const blockNumber = BigInt(event.block.number);
  const blockTimestamp = BigInt(event.block.timestamp);

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

  const newThreshold = event.params.rateChangeThreshold;
  if (cfg.rateChangeThreshold === newThreshold) return;
  context.BreakerConfig.set({ ...cfg, rateChangeThreshold: newThreshold });
}

/** Is `rateFeedID` halted? True when it has at least one ENABLED, non-
 * MARKET_HOURS BreakerConfig in the TRIPPED state — the same predicate the
 * dashboard's `pickTrippableConfig` uses. MARKET_HOURS is excluded on purpose:
 * a weekend FX closure is a scheduled, expected unavailability that already
 * renders via the dashboard's WEEKEND path, not a price-breaker fault.
 *
 * Shared by `syncPoolsBreakerHalt` (breaker-event fan-out) and `upsertPool`
 * (recompute when a pool's feed is first assigned, so a pool that appears
 * mid-halt isn't stuck reading false until the next transition).
 *
 * (Defined here at file end so its insertion doesn't shift the line-keyed
 * ESLint baseline entry for `bootstrapFeedBreakerConfigs` above.) */
export async function computeFeedHalted(
  // Only needs the breaker + dependency entities — narrowed so `upsertPool`
  // (PoolContext) can call it without the full EvmOnEventContext surface.
  context: Pick<
    EvmOnEventContext,
    "BreakerConfig" | "Breaker" | "RateFeedDependency"
  >,
  chainId: number,
  rateFeedID: string,
): Promise<boolean> {
  // Halted if the feed's OWN breakers are tripped...
  if (await computeOwnFeedHalted(context, chainId, rateFeedID)) return true;
  // ...OR if any dependency feed's OWN breakers are tripped. On-chain
  // getRateFeedTradingMode ORs in `rateFeedTradingMode[dep]` (the dependency's
  // direct mode) one level deep, non-recursive — so we OR each dependency's
  // OWN halt, NOT its transitive halt. See RateFeedDependency in schema.graphql.
  const deps = await context.RateFeedDependency.getWhere({
    rateFeedID: { _eq: asAddress(rateFeedID) },
  });
  for (const dep of deps) {
    if (dep.chainId !== chainId) continue;
    if (await computeOwnFeedHalted(context, chainId, dep.dependsOn))
      return true;
  }
  return false;
}

/** Recompute `Pool.breakerTripped` for `rateFeedID` AND every feed that depends
 * on it, persisting any change. Idempotent and self-correcting: each feed's halt
 * is recomputed from its full BreakerConfig + dependency set, so it stays correct
 * regardless of which BreakerBox transition triggered it. Call it after any trip
 * / reset / enable / remove that can move the OR — the reverse-edge fan-out then
 * propagates the change to dependent feeds' pools automatically. */
export async function syncPoolsBreakerHalt(
  context: EvmOnEventContext,
  chainId: number,
  rateFeedID: string,
): Promise<void> {
  const feed = asAddress(rateFeedID);
  await recomputeFeedPools(context, chainId, feed);
  // Reverse-edge fan-out: a trip/reset on `feed` also moves the halt OR for
  // every feed that DEPENDS ON it. One hop only — on-chain dependency
  // resolution is one level, so a dependent's own dependents are unaffected
  // (their OR reads this feed's dependents' OWN modes, not `feed`'s).
  const dependents = await context.RateFeedDependency.getWhere({
    dependsOn: { _eq: feed },
  });
  for (const edge of dependents) {
    if (edge.chainId !== chainId) continue;
    await recomputeFeedPools(context, chainId, edge.rateFeedID);
  }
}

/** Resolve `breakerTripped` for a pool whose rate feed is being (re)assigned in
 * `upsertPool`. Recomputes from the feed's breaker configs only on the
 * unassigned -> assigned transition — so a pool that first appears (or heals
 * its feed) while the feed is already halted isn't stuck `false` until the next
 * BreakerBox event — and otherwise preserves the existing flag. Extracted so
 * `upsertPool` doesn't take on the gate's cognitive complexity. */
export async function breakerTrippedOnFeedAssign(
  context: Pick<
    EvmOnEventContext,
    "BreakerConfig" | "Breaker" | "RateFeedDependency"
  >,
  chainId: number,
  existing: Pick<
    Pool,
    "referenceRateFeedID" | "breakerTripped" | "source" | "wrappedExchangeId"
  >,
  nextReferenceRateFeedID: string,
): Promise<boolean> {
  // VirtualPools (v2) render N/A regardless of breaker state — they aren't
  // health-tracked — so never mark them halted (mirrors the skip in
  // syncPoolsBreakerHalt).
  if (isVirtualPool(existing)) return existing.breakerTripped;
  if (existing.referenceRateFeedID !== "" || nextReferenceRateFeedID === "") {
    return existing.breakerTripped;
  }
  return computeFeedHalted(context, chainId, nextReferenceRateFeedID);
}

/** Cold-start halt fix for the SortedOracles path. When a feed is first seen via
 * an oracle event (`OracleReported` / `MedianUpdated`) and its BreakerBox config
 * events all predate `start_block`, those handlers bootstrap the `BreakerConfig`
 * rows from current on-chain state — which can be already-TRIPPED — but the
 * bootstrap never flows through a BreakerBox handler, so existing pools on the
 * feed keep `breakerTripped=false` until the next live transition. Call this
 * after such a bootstrap (gated on `shouldSync` = "configs were absent and at
 * least one pool references the feed") to recompute the halt once. No-op
 * otherwise, so it's safe to call on every event; `syncPoolsBreakerHalt` itself
 * skips VirtualPools and only writes pools whose flag actually changes.
 *
 * (Defined at file end so its insertion doesn't shift line-keyed baseline
 * entries above.) */
export async function syncHaltOnColdStart(
  context: EvmOnEventContext,
  chainId: number,
  rateFeedID: string,
  shouldSync: boolean,
): Promise<void> {
  if (!shouldSync) return;
  await syncPoolsBreakerHalt(context, chainId, rateFeedID);
}

/** Force `breakerTripped=false` for every pool on `rateFeedID`. Used by the
 * `RateFeedRemoved` handler: once a feed is removed from BreakerBox no breaker
 * governs it, so on-chain `getRateFeedTradingMode` returns unrestricted and the
 * pools are no longer halted. A plain `syncPoolsBreakerHalt` recompute can't be
 * used here — the feed's persisted BreakerConfig rows stay TRIPPED as a
 * historical record (a removed feed receives no further events to reset them),
 * so the recompute would re-derive `true`. Skips VirtualPools (never halted). */
export async function clearPoolsBreakerHalt(
  context: EvmOnEventContext,
  chainId: number,
  rateFeedID: string,
): Promise<void> {
  const poolIds = await getPoolsByFeed(context, chainId, asAddress(rateFeedID));
  for (const poolId of poolIds) {
    const pool = await context.Pool.get(poolId);
    if (!pool || !pool.breakerTripped) continue;
    if (isVirtualPool(pool)) continue;
    context.Pool.set({ ...pool, breakerTripped: false });
  }
}

// ---------------------------------------------------------------------------
// Rate-feed dependency graph (#712)
//
// BreakerBox lets a feed inherit halts from its dependency feeds. We model the
// edges as `RateFeedDependency` rows and OR each dependency's OWN halt into the
// dependent feed's `breakerTripped`. Edges are read from RPC (the on-chain
// event's `dependencies` array is an indexed dynamic type — only a topic hash,
// not decodable) and reconciled (replace, not append) since
// `setRateFeedDependencies` sets the whole array.
//
// (Defined at file end so insertions don't shift line-keyed baseline entries.)
// ---------------------------------------------------------------------------

/** Is `rateFeedID` halted by its OWN breakers? True when it has at least one
 * ENABLED, non-MARKET_HOURS BreakerConfig in the TRIPPED state — the same
 * predicate the dashboard's `pickTrippableConfig` uses. MARKET_HOURS is excluded
 * on purpose: a weekend FX closure is a scheduled unavailability that renders via
 * the dashboard's WEEKEND path, not a price-breaker fault. This is the per-feed
 * primitive `computeFeedHalted` ORs over self + each dependency (one level). */
async function computeOwnFeedHalted(
  context: Pick<EvmOnEventContext, "BreakerConfig" | "Breaker">,
  chainId: number,
  rateFeedID: string,
): Promise<boolean> {
  const configs = await context.BreakerConfig.getWhere({
    rateFeedID: { _eq: asAddress(rateFeedID) },
  });
  for (const cfg of configs) {
    if (cfg.chainId !== chainId) continue;
    if (!cfg.enabled) continue;
    if (cfg.status !== "TRIPPED") continue;
    const breaker = await context.Breaker.get(cfg.breaker_id);
    if (!breaker || breaker.kind === "MARKET_HOURS") continue;
    return true;
  }
  return false;
}

/** Recompute `Pool.breakerTripped` (dependency-aware) for every pool on a single
 * feed and persist any change. The per-feed core of `syncPoolsBreakerHalt`,
 * split out so the reverse-edge fan-out applies it to each dependent without
 * recursing back into the fan-out (keeps propagation one hop). */
async function recomputeFeedPools(
  context: EvmOnEventContext,
  chainId: number,
  rateFeedID: string,
): Promise<void> {
  const halted = await computeFeedHalted(context, chainId, rateFeedID);
  const poolIds = await getPoolsByFeed(context, chainId, asAddress(rateFeedID));
  for (const poolId of poolIds) {
    const pool = await context.Pool.get(poolId);
    if (!pool || pool.breakerTripped === halted) continue;
    // VirtualPools (v2) stay N/A regardless of breaker state.
    if (isVirtualPool(pool)) continue;
    context.Pool.set({ ...pool, breakerTripped: halted });
  }
}

/** ID for a `RateFeedDependency` edge: `{chainId}-{rateFeedID}-{dependsOn}`. */
export function makeRateFeedDependencyId(
  chainId: number,
  rateFeedID: string,
  dependsOn: string,
): string {
  return `${chainId}-${asAddress(rateFeedID)}-${asAddress(dependsOn)}`;
}

/** Reconcile `rateFeedID`'s persisted dependency edges to `deps` (the current
 * on-chain set): delete edges no longer present, upsert the rest. Replace (not
 * merge) semantics mirror `setRateFeedDependencies`, which sets the whole array. */
async function reconcileDependencyEdges(
  context: EvmOnEventContext,
  chainId: number,
  rateFeedID: string,
  deps: string[],
): Promise<void> {
  const feed = asAddress(rateFeedID);
  const want = new Set(deps.map((d) => asAddress(d)));
  const existing = await context.RateFeedDependency.getWhere({
    rateFeedID: { _eq: feed },
  });
  for (const edge of existing) {
    if (edge.chainId !== chainId) continue;
    if (!want.has(edge.dependsOn))
      context.RateFeedDependency.deleteUnsafe(edge.id);
  }
  for (const dependsOn of want) {
    const row: RateFeedDependency = {
      id: makeRateFeedDependencyId(chainId, feed, dependsOn),
      chainId,
      rateFeedID: feed,
      dependsOn,
    };
    context.RateFeedDependency.set(row);
  }
}

/** RPC-read `rateFeedID`'s current dependency set and reconcile its edges.
 * Returns true when edges were (re)loaded (caller should re-sync the feed's
 * pools), false when skipped (already attempted / within backoff) or the RPC
 * read failed. Reuses the breaker-bootstrap caches under a `dep:` key namespace
 * so a feed's deps are read at most once per process unless `force` (the
 * RateFeedDependenciesSet handler) bypasses the cache to pick up a change. */
export async function loadFeedDependencies(args: {
  context: EvmOnEventContext;
  chainId: number;
  rateFeedID: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
  force?: boolean;
}): Promise<boolean> {
  const { context, chainId, rateFeedID, blockNumber, blockTimestamp } = args;
  const cacheKey = `dep:${chainId}:${rateFeedID.toLowerCase()}`;
  if (!args.force) {
    if (_bootstrapAttempted.has(cacheKey)) return false;
    const backoffUntil = _bootstrapBackoffUntilTs.get(cacheKey);
    if (backoffUntil !== undefined && blockTimestamp < backoffUntil)
      return false;
  }
  const deps = await context.effect(rateFeedDependenciesEffect, {
    chainId,
    rateFeedID,
    blockNumber,
  });
  if (deps === null) {
    setBootstrapBackoff(cacheKey, blockTimestamp + BOOTSTRAP_BACKOFF_SECONDS);
    // A forced refresh that fails must not stay "attempted", or a later oracle
    // event won't retry the changed set.
    if (args.force) _bootstrapAttempted.delete(cacheKey);
    return false;
  }
  await reconcileDependencyEdges(context, chainId, rateFeedID, deps);
  markBootstrapAttempted(cacheKey);
  _bootstrapBackoffUntilTs.delete(cacheKey);
  return true;
}

/** Cold-start for the dependency graph, mirroring `syncHaltOnColdStart` for the
 * breaker-config graph. The current dependency edges were set before
 * `start_block`, so no `RateFeedDependenciesSet` fires in our range — load them
 * (once per feed) on the dependent's oracle events. If a dependency is already
 * tripped, the feed's pools must reflect the inherited halt, so re-sync when the
 * edges are first loaded. Gated on `hasPools` (a feed with no pools has no
 * `breakerTripped` to set; its halt still propagates to its dependents via their
 * own load + the breaker-event fan-out). No-op once loaded, so safe per event. */
export async function syncDependencyHaltOnColdStart(args: {
  context: EvmOnEventContext;
  chainId: number;
  rateFeedID: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
  hasPools: boolean;
}): Promise<void> {
  if (!args.hasPools) return;
  const loaded = await loadFeedDependencies({
    context: args.context,
    chainId: args.chainId,
    rateFeedID: args.rateFeedID,
    blockNumber: args.blockNumber,
    blockTimestamp: args.blockTimestamp,
  });
  if (loaded) {
    await syncPoolsBreakerHalt(args.context, args.chainId, args.rateFeedID);
  }
}
