"use client";

import { useEffect, useState } from "react";
import { useGQL } from "@/lib/graphql";
import { useNetwork } from "@/components/network-provider";
import { POOL_BREAKER_CONFIG } from "@/lib/queries";
import type { BreakerConfig, BreakerTripEvent, Pool } from "@/lib/types";
import { isVirtualPool } from "@/lib/types";
import { InfoPopover } from "@/components/info-popover";
import { explorerTxUrl } from "@/lib/tokens";
import { formatTimestamp, relativeTime } from "@/lib/format";
import { formatDurationShort } from "@/lib/bridge-status";

type Props = {
  pool: Pool;
};

type Response = {
  BreakerConfig: BreakerConfig[];
  BreakerTripEvent: BreakerTripEvent[];
};

const FIXED_1 = BigInt(10) ** BigInt(24);
// Breaker thresholds are stored as Fixidity (1e24 = 100%). Keep one decimal
// pair throughout the panel: 4.00% / 0.150% etc. We render two decimals for
// FX (4.00%) and three for stablecoin (0.150%) to match the precision of
// the on-chain config without trailing-zero clutter.
const PRECISION_BY_KIND: Record<string, number> = {
  MEDIAN_DELTA: 2,
  VALUE_DELTA: 3,
};

function formatFixidityPct(
  raw: string | null | undefined,
  precision: number,
): string | null {
  if (!raw) return null;
  // Convert Fixidity (1e24=100%) to percent. Avoid Number for big values —
  // do it in BigInt with a /1e22 trick to preserve precision.
  const value = BigInt(raw);
  if (value <= BigInt(0)) return null;
  const scale = BigInt(10) ** BigInt(22 - precision);
  const scaled = value / scale; // integer with `precision` decimals worth of percent
  const whole = scaled / BigInt(10) ** BigInt(precision);
  const frac = scaled % BigInt(10) ** BigInt(precision);
  return `${whole}.${frac.toString().padStart(precision, "0")}%`;
}

/** Format a Fixidity-scaled number with 6 decimals (e.g. EMA = 1.171560). */
function formatFixidityValue(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = BigInt(raw);
  if (value === BigInt(0)) return null;
  const whole = value / FIXED_1;
  const frac = value % FIXED_1;
  // Render 6 decimals: scale frac by 10^6 / FIXED_1 = 10^6 / 10^24 = 10^-18.
  const fracScaled = frac / BigInt(10) ** BigInt(18);
  return `${whole}.${fracScaled.toString().padStart(6, "0")}`;
}

/** Returns the trip-able BreakerConfig (filters out MARKET_HOURS, which has
 * no per-feed config and is rendered as the title-row pill instead). Prefers
 * enabled configs; production has ≤1 trip-able config per feed today. */
function pickTrippableConfig(configs: BreakerConfig[]): BreakerConfig | null {
  const candidates = configs.filter((c) => c.breaker.kind !== "MARKET_HOURS");
  return candidates.find((c) => c.enabled) ?? candidates[0] ?? null;
}

/** Effective threshold (Fixidity). Per-feed override else breaker default. */
function effectiveThreshold(cfg: BreakerConfig): bigint {
  const override = BigInt(cfg.rateChangeThreshold);
  if (override > BigInt(0)) return override;
  return BigInt(cfg.breaker.defaultRateChangeThreshold);
}

/** Effective cooldown in seconds. Per-feed override else breaker default. */
function effectiveCooldown(cfg: BreakerConfig): bigint {
  const override = BigInt(cfg.cooldownTime);
  if (override > BigInt(0)) return override;
  return BigInt(cfg.breaker.defaultCooldownTime);
}

/** |median - reference| / reference, returned as a Fixidity ratio (1e24 = 100%).
 * Returns null if either value is missing. */
function computeLiveDelta(cfg: BreakerConfig): bigint | null {
  const median = cfg.lastMedianRate ? BigInt(cfg.lastMedianRate) : null;
  const reference =
    cfg.breaker.kind === "MEDIAN_DELTA"
      ? cfg.medianRatesEMA
        ? BigInt(cfg.medianRatesEMA)
        : null
      : cfg.referenceValue
        ? BigInt(cfg.referenceValue)
        : null;
  if (!median || !reference || reference === BigInt(0)) return null;
  const diff = median > reference ? median - reference : reference - median;
  return (diff * FIXED_1) / reference;
}

/** Returns the bar fill (0-100) and color class for the live-Δ bar. Mirrors
 * the deviation-bar conventions in components/pool-header/deviation-cell.tsx. */
function deltaBarStyle(
  deltaFixidity: bigint,
  thresholdFixidity: bigint,
): {
  pct: number;
  color: string;
} {
  if (thresholdFixidity <= BigInt(0)) {
    return { pct: 0, color: "bg-slate-600" };
  }
  // ratio = delta / threshold, capped at 1.5 for visual purposes.
  const ratioBP = (deltaFixidity * BigInt(10000)) / thresholdFixidity;
  const ratio = Number(ratioBP) / 10000;
  const pct = Math.min(ratio * 100, 100);
  const color =
    ratio >= 1
      ? "bg-red-500"
      : ratio >= 0.8
        ? "bg-yellow-500"
        : "bg-emerald-500";
  return { pct, color };
}

export function BreakerPanel({ pool }: Props): React.ReactElement | null {
  const { network } = useNetwork();
  const isVirtual = isVirtualPool(pool);
  const rateFeedID = pool.referenceRateFeedID ?? "";

  const { data } = useGQL<Response>(
    !isVirtual && rateFeedID ? POOL_BREAKER_CONFIG : null,
    { chainId: pool.chainId, rateFeedID },
  );

  const configs = data?.BreakerConfig ?? [];
  const trips = data?.BreakerTripEvent ?? [];
  const cfg = pickTrippableConfig(configs);
  const tripped = cfg?.status === "TRIPPED";
  // The 1-second ticker only matters during cooldown (it drives the
  // countdown text + the reset-path "elapsed" check). Healthy state shows
  // static text — skip the interval to avoid recurring re-renders for nothing.
  const tickerActive = !!cfg && tripped;

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!tickerActive) return;
    const id = setInterval(() => {
      // Guard against same-second re-renders: setState bails on identical
      // values when the updater returns the previous reference.
      setNow((prev) => {
        const next = Math.floor(Date.now() / 1000);
        return next !== prev ? next : prev;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [tickerActive]);

  if (isVirtual || !rateFeedID) return null;
  // No trip-able breaker (e.g. feed not registered with BreakerBox) → no panel.
  if (!cfg) return null;

  const kind = cfg.breaker.kind;
  const threshold = effectiveThreshold(cfg);
  const cooldown = effectiveCooldown(cfg);
  const cooldownEndsAt = Number(cfg.cooldownEndsAt);
  const cooldownRemainingSec = Math.max(0, cooldownEndsAt - now);
  const liveDelta = computeLiveDelta(cfg);
  const precision = PRECISION_BY_KIND[kind] ?? 2;

  const referenceLabel =
    kind === "MEDIAN_DELTA" ? "EMA Reference" : "Reference";
  const liveDeltaLabel =
    kind === "MEDIAN_DELTA" ? "Δ Oracle Price vs EMA" : "Δ Oracle Price vs Peg";
  const referenceCaption =
    kind === "MEDIAN_DELTA"
      ? `smoothing ${formatFixidityPct(cfg.smoothingFactor, 1) ?? "—"}`
      : "fixed peg";
  const thresholdCaption =
    kind === "MEDIAN_DELTA"
      ? `trips at >${formatFixidityPct(threshold.toString(), precision) ?? "—"} from EMA`
      : `trips at >${formatFixidityPct(threshold.toString(), precision) ?? "—"} from peg`;

  const formattedThreshold =
    formatFixidityPct(threshold.toString(), precision) ?? "—";
  const formattedCooldown = formatDurationShort(Number(cooldown));
  const formattedReference =
    kind === "MEDIAN_DELTA"
      ? formatFixidityValue(cfg.medianRatesEMA)
      : formatFixidityValue(cfg.referenceValue);
  const formattedLiveDelta = liveDelta
    ? (formatFixidityPct(liveDelta.toString(), precision) ?? "—")
    : "—";
  const liveBar = liveDelta
    ? deltaBarStyle(liveDelta, threshold)
    : { pct: 0, color: "bg-slate-600" };

  const todayMidnightSec = Math.floor(now / 86400) * 86400; // UTC midnight
  const tripsToday = trips.filter(
    (t) => Number(t.blockTimestamp) >= todayMidnightSec,
  ).length;
  const lifetimeCount = cfg.tripCountLifetime;
  const lastTripTs = cfg.lastTripAt;

  // Reset-path conditions (mirror BreakerBox.tryResetBreaker).
  const cooldownElapsed = cooldownRemainingSec === 0;
  const rateInBand = liveDelta != null && liveDelta < threshold;

  return (
    <>
      <div className="my-5 h-px bg-slate-800" />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm sm:grid-cols-3 lg:grid-cols-5">
        <div title={`${cfg.breaker.kind} breaker · ${cfg.breaker.address}`}>
          <dt className="text-slate-400 inline-flex items-center gap-1">
            Breaker
            <InfoPopover
              label="Breaker"
              content="On-chain circuit breaker that halts trading when the oracle price moves more than the configured threshold from the reference. Reset is automatic on the next oracle report once cooldown elapses AND the rate returns inside the band."
            />
          </dt>
          <dd className="flex flex-col gap-0.5">
            <span className={tripped ? "text-red-400" : "text-emerald-400"}>
              {kind === "MEDIAN_DELTA" ? "MedianDelta" : "ValueDelta"}
            </span>
            <span
              className={`text-xs ${tripped ? "text-red-300" : "text-slate-500"}`}
            >
              trading mode {cfg.tradingMode}
              {tripped && " · halted"}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">{referenceLabel}</dt>
          <dd className="flex flex-col gap-0.5">
            <span className="font-mono text-white">
              {formattedReference ?? "—"}
            </span>
            <span className="text-xs text-slate-500">{referenceCaption}</span>
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Threshold / Cooldown</dt>
          <dd className="flex flex-col gap-0.5">
            <span className="font-mono text-white">
              {formattedThreshold} / {formattedCooldown}
            </span>
            <span
              className={`text-xs ${
                tripped && cooldownRemainingSec > 0
                  ? "text-amber-300"
                  : "text-slate-500"
              }`}
            >
              {tripped && cooldownRemainingSec > 0
                ? `${formatDurationShort(cooldownRemainingSec)} left`
                : thresholdCaption}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">{liveDeltaLabel}</dt>
          <dd className="flex flex-col gap-0.5">
            <div className="flex h-5 items-center">
              <div className="h-2 w-full rounded-full bg-slate-700 mt-1">
                <div
                  className={`h-2 rounded-full transition-all ${liveBar.color}`}
                  style={{ width: `${liveBar.pct}%` }}
                  role="progressbar"
                  aria-label="Live oracle Δ vs reference"
                  aria-valuenow={Math.round(liveBar.pct)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                />
              </div>
            </div>
            <span
              className={`text-xs ${tripped ? "text-red-300" : "text-slate-500"}`}
            >
              {liveDelta
                ? `${formattedLiveDelta} of ${formattedThreshold}`
                : "—"}
              {tripped && liveDelta && liveDelta >= threshold && " (over)"}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-slate-400 flex items-center justify-between gap-1">
            <span>Last trip</span>
            {tripped && lastTripTs && (
              <span className="text-xs font-normal text-red-400">
                tripped {relativeTime(lastTripTs)}
              </span>
            )}
          </dt>
          <dd className="flex flex-col gap-0.5">
            {lastTripTs && cfg.lastTripTxHash ? (
              <a
                href={explorerTxUrl(network, cfg.lastTripTxHash)}
                target="_blank"
                rel="noopener noreferrer"
                className={`${
                  tripped ? "text-red-300" : "text-indigo-300"
                } hover:text-indigo-400`}
                title={formatTimestamp(lastTripTs)}
              >
                {relativeTime(lastTripTs)}
              </a>
            ) : (
              <span className="text-slate-500">never</span>
            )}
            <span
              className={`text-xs ${
                tripsToday > 0 ? "text-amber-300" : "text-slate-500"
              }`}
            >
              {lifetimeCount} lifetime
              {tripsToday > 0 && ` · ${tripsToday} today`}
            </span>
          </dd>
        </div>
      </dl>

      {tripped && (
        <div className="mt-4 rounded border border-red-900/40 bg-red-950/30 px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          <span className="text-red-300 font-medium">Reset path</span>
          <span className="inline-flex items-center gap-1">
            <span
              className={cooldownElapsed ? "text-emerald-300" : "text-red-300"}
            >
              {cooldownElapsed ? "✓" : "✗"}
            </span>
            Cooldown
            <span
              className={`font-mono ${
                cooldownElapsed ? "text-emerald-300" : "text-amber-300"
              }`}
            >
              {cooldownElapsed
                ? "elapsed"
                : formatDurationShort(cooldownRemainingSec)}
            </span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span className={rateInBand ? "text-emerald-300" : "text-red-300"}>
              {rateInBand ? "✓" : "✗"}
            </span>
            Rate in band
            <span
              className={`font-mono ${
                rateInBand ? "text-emerald-300" : "text-red-300"
              }`}
            >
              {liveDelta
                ? `${formattedLiveDelta} ${rateInBand ? "<" : ">"} ${formattedThreshold}`
                : "—"}
            </span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="text-slate-500">·</span>
            <span className="text-slate-300">Next oracle report</span>
          </span>
          <span className="text-slate-500 ml-auto">
            Reset is automatic on next report once both are ✓
          </span>
        </div>
      )}
    </>
  );
}
