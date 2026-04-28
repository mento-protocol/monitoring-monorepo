// ---------------------------------------------------------------------------
// Breaker handler helpers — entity ID composition, upsert, RPC self-heal.
//
// The on-chain BreakerBox + MedianDelta + ValueDelta were deployed before our
// indexer's `start_block` on both chains, so initial config events (BreakerAdded,
// BreakerStatusUpdated, RateChangeThresholdUpdated, etc.) are not in our event
// stream. On the first event for any (breaker, feed) pair we don't yet know,
// hydrate from RPC via `fetchBreakerDefaults` / `fetchBreakerFeedState`.
// ---------------------------------------------------------------------------

import type { Breaker, BreakerConfig } from "generated";
import type { HandlerContext } from "generated/src/Types";
import { asAddress } from "./helpers";
import {
  fetchBreakerDefaults,
  fetchBreakerFeedState,
  fetchBreakerKind,
  type BreakerKindRpc,
} from "./rpc";

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
  context: HandlerContext,
  chainId: number,
  breakerAddress: string,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<Breaker | null> {
  const id = makeBreakerId(chainId, breakerAddress);
  const existing = await context.Breaker.get(id);
  if (existing) return existing;

  const kind = await fetchBreakerKind(chainId, breakerAddress);
  const defaults = await fetchBreakerDefaults(
    chainId,
    breakerAddress,
    kind,
    blockNumber,
  );
  if (!defaults) return null;

  const breaker: Breaker = {
    id,
    chainId,
    address: asAddress(breakerAddress),
    kind,
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
  context: HandlerContext,
  chainId: number,
  breaker: Breaker,
  rateFeedID: string,
  blockNumber: bigint,
): Promise<BreakerConfig | null> {
  const id = makeBreakerConfigId(chainId, breaker.address, rateFeedID);
  const existing = await context.BreakerConfig.get(id);
  if (existing) return existing;

  const state = await fetchBreakerFeedState(
    chainId,
    breaker.address,
    breaker.kind as BreakerKindRpc,
    rateFeedID,
    blockNumber,
  );
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

/** Refresh `BreakerConfig.cooldownEndsAt` after a cooldown-related field
 * change. The pre-rolled `cooldownEndsAt = lastStatusUpdatedAt +
 * cooldownTime` formula uses the EFFECTIVE cooldown (per-feed override else
 * breaker default), so any of those three values changing requires a rerun. */
export async function refreshCooldownEndsAt(
  context: HandlerContext,
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
  context: HandlerContext,
  breaker: Breaker,
): Promise<void> {
  const configs = await context.BreakerConfig.getWhere.breakerAddress.eq(
    breaker.address,
  );
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
  context: HandlerContext;
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
  context: HandlerContext;
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
  context: HandlerContext;
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
  await refreshCooldownEndsAt(context, { ...cfg, cooldownTime: newCooldown });
}

export async function handleRateChangeThresholdUpdated({
  event,
  context,
}: {
  event: RateFeedThresholdEvent;
  context: HandlerContext;
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
