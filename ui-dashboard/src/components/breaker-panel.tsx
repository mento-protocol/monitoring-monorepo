"use client";

import { useEffect, useState } from "react";
import { useGQL } from "@/lib/graphql";
import { useNetwork } from "@/components/network-provider";
import { POOL_BREAKER_CONFIG } from "@/lib/queries";
import type { BreakerConfig, BreakerTripEvent, Pool } from "@/lib/types";
import { isVirtualPool } from "@/lib/types";
import { effectiveBreakerThreshold, pickTrippableConfig } from "@/lib/breaker";
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
  if (raw === null || raw === undefined) return null;
  // Convert Fixidity (1e24=100%) to percent. Avoid Number for big values —
  // do it in BigInt with a /1e22 trick to preserve precision. Treats 0 as a
  // legitimate value (median exactly equals reference) — renders "0.00%",
  // not the missing-data dash.
  const value = BigInt(raw);
  if (value < BigInt(0)) return null;
  const scale = BigInt(10) ** BigInt(22 - precision);
  const scaled = value / scale;
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

function fixidityOrNull(raw: string | null | undefined): bigint | null {
  if (raw == null) return null;
  const value = BigInt(raw);
  return value === BigInt(0) ? null : value;
}

function breakerConfigQuery(
  isVirtual: boolean,
  rateFeedID: string,
): string | null {
  return !isVirtual && rateFeedID ? POOL_BREAKER_CONFIG : null;
}

/** Effective cooldown in seconds. Per-feed override else breaker default. */
function effectiveCooldown(cfg: BreakerConfig): bigint {
  const override = BigInt(cfg.cooldownTime);
  if (override > BigInt(0)) return override;
  return BigInt(cfg.breaker.defaultCooldownTime);
}

/** |median - reference| / reference, returned as a Fixidity ratio (1e24 = 100%).
 * Returns null if either input is missing OR is the on-chain `0` sentinel:
 * SortedOracles returns rate `0` when all oracle reports have expired,
 * `medianRatesEMA = 0` is the contract's "uninitialized" marker (until the
 * first MedianUpdated seeds it), and a `referenceValue` of `0` would be a
 * mis-set peg (also produces a divide-by-zero). In all three cases the live
 * Δ is meaningless, so render the missing-data dash. */
function computeLiveDelta(cfg: BreakerConfig): bigint | null {
  const median = fixidityOrNull(cfg.lastMedianRate);
  const reference =
    cfg.breaker.kind === "MEDIAN_DELTA"
      ? fixidityOrNull(cfg.medianRatesEMA)
      : fixidityOrNull(cfg.referenceValue);
  if (median == null || reference == null) return null;
  const diff = median > reference ? median - reference : reference - median;
  return (diff * FIXED_1) / reference;
}

function referenceValue(cfg: BreakerConfig): bigint | null {
  const raw =
    cfg.breaker.kind === "MEDIAN_DELTA"
      ? cfg.medianRatesEMA
      : cfg.referenceValue;
  return fixidityOrNull(raw);
}

function actualValue(cfg: BreakerConfig): bigint | null {
  return fixidityOrNull(cfg.lastMedianRate);
}

function valueDeltaDirection(cfg: BreakerConfig): "above" | "below" | null {
  const reference = referenceValue(cfg);
  const actual = actualValue(cfg);
  if (reference == null || actual == null || actual === reference) return null;
  return actual > reference ? "above" : "below";
}

type BreakerPresentation = {
  referenceLabel: string;
  liveDeltaLabel: string;
  thresholdCaption: string;
  formattedThreshold: string;
  formattedCooldown: string;
  formattedReference: string | null;
  formattedActual: string | null;
  formattedLiveDelta: string;
  breachedValueClass: string;
  referenceCaption: string;
  isOverTolerance: boolean;
};

function isMedianDelta(cfg: BreakerConfig): boolean {
  return cfg.breaker.kind === "MEDIAN_DELTA";
}

function referenceCaptionFor(
  cfg: BreakerConfig,
  tripped: boolean,
  isOverTolerance: boolean,
  formattedLiveDelta: string,
): string {
  if (isMedianDelta(cfg)) {
    return `smoothing ${formatFixidityPct(cfg.smoothingFactor, 1) ?? "—"}`;
  }
  const pegDirection = valueDeltaDirection(cfg);
  if (tripped && isOverTolerance && pegDirection) {
    // `isOverTolerance` implies a non-null live delta, so this is never "—".
    return `${formattedLiveDelta} ${pegDirection} peg`;
  }
  return "fixed peg";
}

function breakerPresentation(
  cfg: BreakerConfig,
  threshold: bigint,
  cooldown: bigint,
  liveDelta: bigint | null,
  tripped: boolean,
): BreakerPresentation {
  const kind = cfg.breaker.kind;
  const precision = PRECISION_BY_KIND[kind] ?? 2;
  const formattedThreshold =
    formatFixidityPct(threshold.toString(), precision) ?? "—";
  const formattedLiveDelta =
    liveDelta != null
      ? (formatFixidityPct(liveDelta.toString(), precision) ?? "—")
      : "—";
  const isOverTolerance =
    threshold > BigInt(0) && liveDelta != null && liveDelta >= threshold;

  return {
    referenceLabel:
      kind === "MEDIAN_DELTA"
        ? "EMA Reference vs Actual"
        : "Reference vs Actual",
    liveDeltaLabel:
      kind === "MEDIAN_DELTA"
        ? "Δ Oracle Price vs EMA"
        : "Δ Oracle Price vs Peg",
    thresholdCaption:
      kind === "MEDIAN_DELTA"
        ? `trips at >${formattedThreshold} from EMA`
        : `trips at >${formattedThreshold} from peg`,
    formattedThreshold,
    formattedCooldown: formatDurationShort(Number(cooldown)),
    formattedReference: formatFixidityValue(
      kind === "MEDIAN_DELTA" ? cfg.medianRatesEMA : cfg.referenceValue,
    ),
    formattedActual: formatFixidityValue(cfg.lastMedianRate),
    formattedLiveDelta,
    breachedValueClass:
      tripped && isOverTolerance ? "text-red-300" : "text-white",
    referenceCaption: referenceCaptionFor(
      cfg,
      tripped,
      isOverTolerance,
      formattedLiveDelta,
    ),
    isOverTolerance,
  };
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

function BreakerIdentityMetric({
  cfg,
  tripped,
}: {
  cfg: BreakerConfig;
  tripped: boolean;
}): React.ReactElement {
  const kind = cfg.breaker.kind;
  return (
    <div title={`${kind} breaker · ${cfg.breaker.address}`}>
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
        {/* `title=` is a tooltip for sighted users; mirror its text into
            an `sr-only` span so screen readers also surface the breaker
            kind + address. Mirrors the MarketHoursPill pattern. */}
        <span className="sr-only">
          {kind} breaker at address {cfg.breaker.address}
        </span>
      </dd>
    </div>
  );
}

function ReferenceMetric({
  presentation,
}: {
  presentation: BreakerPresentation;
}): React.ReactElement {
  return (
    <div>
      <dt className="text-slate-400">{presentation.referenceLabel}</dt>
      <dd className="flex flex-col gap-0.5">
        <span className={`font-mono ${presentation.breachedValueClass}`}>
          <span className="text-slate-500">ref </span>
          {presentation.formattedReference ?? "—"}
          <span className="text-slate-500"> / actual </span>
          {presentation.formattedActual ?? "—"}
        </span>
        <span className="text-xs text-slate-500">
          {presentation.referenceCaption}
        </span>
      </dd>
    </div>
  );
}

function ThresholdMetric({
  presentation,
  tripped,
  cooldownRemainingSec,
}: {
  presentation: BreakerPresentation;
  tripped: boolean;
  cooldownRemainingSec: number;
}): React.ReactElement {
  const cooldownActive = tripped && cooldownRemainingSec > 0;
  return (
    <div>
      <dt className="text-slate-400">Threshold / Cooldown</dt>
      <dd className="flex flex-col gap-0.5">
        <span className="font-mono text-white">
          {presentation.formattedThreshold} / {presentation.formattedCooldown}
        </span>
        <span
          className={`text-xs ${cooldownActive ? "text-amber-300" : "text-slate-500"}`}
        >
          {cooldownActive
            ? `${formatDurationShort(cooldownRemainingSec)} left`
            : presentation.thresholdCaption}
        </span>
      </dd>
    </div>
  );
}

function LiveDeltaMetric({
  presentation,
  liveDelta,
  liveBar,
  tripped,
}: {
  presentation: BreakerPresentation;
  liveDelta: bigint | null;
  liveBar: { pct: number; color: string };
  tripped: boolean;
}): React.ReactElement {
  return (
    <div>
      <dt className="text-slate-400">{presentation.liveDeltaLabel}</dt>
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
          {liveDelta != null
            ? `${presentation.formattedLiveDelta} of ${presentation.formattedThreshold}`
            : "—"}
          {tripped && presentation.isOverTolerance && " (over)"}
        </span>
      </dd>
    </div>
  );
}

function LastTripMetric({
  cfg,
  network,
  tripped,
  tripsToday,
}: {
  cfg: BreakerConfig;
  network: ReturnType<typeof useNetwork>["network"];
  tripped: boolean;
  tripsToday: number;
}): React.ReactElement {
  const lastTripTs = cfg.lastTripAt;
  return (
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
          className={`text-xs ${tripsToday > 0 ? "text-amber-300" : "text-slate-500"}`}
        >
          {cfg.tripCountLifetime} lifetime
          {tripsToday > 0 && ` · ${tripsToday} today`}
        </span>
      </dd>
    </div>
  );
}

function ResetPathBanner({
  cooldownElapsed,
  cooldownRemainingSec,
  rateInBand,
  liveDelta,
  presentation,
}: {
  cooldownElapsed: boolean;
  cooldownRemainingSec: number;
  rateInBand: boolean;
  liveDelta: bigint | null;
  presentation: BreakerPresentation;
}): React.ReactElement {
  return (
    <div className="mt-4 rounded border border-red-900/40 bg-red-950/30 px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
      <span className="text-red-300 font-medium">Reset path</span>
      <span className="inline-flex items-center gap-1">
        <span className={cooldownElapsed ? "text-emerald-300" : "text-red-300"}>
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
          {liveDelta != null
            ? `${presentation.formattedLiveDelta} ${rateInBand ? "<" : ">"} ${presentation.formattedThreshold}`
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
  );
}

export function BreakerPanel({ pool }: Props): React.ReactElement | null {
  const { network } = useNetwork();
  const isVirtual = isVirtualPool(pool);
  const rateFeedID = pool.referenceRateFeedID ?? "";

  const { data } = useGQL<Response>(breakerConfigQuery(isVirtual, rateFeedID), {
    chainId: pool.chainId,
    rateFeedID,
  });

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

  if (isVirtual || !rateFeedID || !cfg) return null;
  // No trip-able breaker (e.g. feed not registered with BreakerBox) → no panel.

  const threshold = effectiveBreakerThreshold(cfg);
  const cooldown = effectiveCooldown(cfg);
  const cooldownEndsAt = Number(cfg.cooldownEndsAt);
  const cooldownRemainingSec = Math.max(0, cooldownEndsAt - now);
  const liveDelta = computeLiveDelta(cfg);
  const presentation = breakerPresentation(
    cfg,
    threshold,
    cooldown,
    liveDelta,
    tripped,
  );
  const liveBar =
    liveDelta != null
      ? deltaBarStyle(liveDelta, threshold)
      : { pct: 0, color: "bg-slate-600" };

  const todayMidnightSec = Math.floor(now / 86400) * 86400; // UTC midnight
  // Filter by THIS breaker's address — the query is feed-scoped, but a
  // single feed could surface multiple breakers' trips (only one trip-able
  // breaker today, but MarketHours-style additions later would drift the
  // count from cfg.tripCountLifetime if we didn't scope it).
  const tripsToday = trips.filter(
    (t) =>
      Number(t.blockTimestamp) >= todayMidnightSec &&
      t.breaker.address === cfg.breaker.address,
  ).length;

  // Reset-path conditions (mirror BreakerBox.tryResetBreaker).
  const cooldownElapsed = cooldownRemainingSec === 0;
  const rateInBand = liveDelta != null && liveDelta < threshold;

  return (
    <>
      <div className="my-5 h-px bg-slate-800" />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm sm:grid-cols-3 lg:grid-cols-5">
        <BreakerIdentityMetric cfg={cfg} tripped={tripped} />
        <ReferenceMetric presentation={presentation} />
        <ThresholdMetric
          presentation={presentation}
          tripped={tripped}
          cooldownRemainingSec={cooldownRemainingSec}
        />
        <LiveDeltaMetric
          presentation={presentation}
          liveDelta={liveDelta}
          liveBar={liveBar}
          tripped={tripped}
        />
        <LastTripMetric
          cfg={cfg}
          network={network}
          tripped={tripped}
          tripsToday={tripsToday}
        />
      </dl>

      {tripped && (
        <ResetPathBanner
          cooldownElapsed={cooldownElapsed}
          cooldownRemainingSec={cooldownRemainingSec}
          rateInBand={rateInBand}
          liveDelta={liveDelta}
          presentation={presentation}
        />
      )}
    </>
  );
}
