"use client";

import { useEffect, useState } from "react";
import { useGQL } from "@/lib/graphql";
import { useNetwork } from "@/components/network-provider";
import { type PoolBreakerConfigResponse } from "@/lib/queries";
import { BREAKER_CONFIG_TIMEOUT_MS } from "@/lib/hasura-timeout";
import type { BreakerConfig, BreakerTripEvent, Pool } from "@/lib/types";
import { isVirtualPool } from "@/lib/types";
import { pickTrippableConfig } from "@/lib/breaker";
import { Tooltip } from "@/components/tooltip";
import { ErrorBox, StaleRefreshNotice } from "@/components/feedback";
import { explorerTxUrl } from "@/lib/tokens";
import { formatDurationShort } from "@/lib/bridge-status";
import {
  useNowSeconds,
  useSsrSafeRelative,
  useSsrSafeTimestamp,
} from "@/hooks/use-now-seconds";
// Fixidity math, cooldown/trip-count derivations, and the presentation view
// model live in the sibling module to keep this file under the repo's
// file-size soft cap — see breaker-panel-math.ts's header comment.
import {
  breakerConfigQuery,
  deriveBreakerView,
  isBreakerConfigQueryPending,
  isBreakerFetchUnavailable,
  tripsTodayDisplay,
  type BreakerPresentation,
  type TripsTodayDisplay,
} from "./breaker-panel-math";

type Props = {
  pool: Pool;
  /** Server-prefetched breaker config, forwarded to SWR as `fallbackData` so
   *  the panel knows on first paint whether the pool has a trip-able breaker —
   *  no skeleton→null collapse for pools that resolve to none (issue #1237). */
  initialBreakerConfig?: PoolBreakerConfigResponse | undefined;
};

type Response = {
  BreakerConfig: BreakerConfig[];
  BreakerTripEvent: BreakerTripEvent[];
};

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
        <Tooltip
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
  cooldownRemainingSec: number | null;
}): React.ReactElement {
  const cooldownActive =
    tripped && cooldownRemainingSec !== null && cooldownRemainingSec > 0;
  // `cooldownRemainingSec` is `null` pre-mount even when `tripped` (the
  // ticker hasn't read the wall clock yet — see BreakerPanel's `now` state).
  // We can't tell from `null` whether the on-chain cooldown is still active
  // or has already elapsed, so render the state-neutral "—" rather than
  // asserting either one; the real caption lands once the ticker's first
  // tick resolves `now`.
  const cooldownPending = tripped && cooldownRemainingSec === null;
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
          {cooldownActive && cooldownRemainingSec !== null
            ? `${formatDurationShort(cooldownRemainingSec)} left`
            : cooldownPending
              ? "—"
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
  tripsToday: TripsTodayDisplay;
}): React.ReactElement {
  // Amber "activity today" treatment only for a RESOLVED non-zero count. The
  // pre-mount `pending` placeholder stays neutral slate — matching the resolved
  // zero-today (`hidden`) state — so a historically-tripped pool with no trip
  // today resolves slate→slate (a horizontal "· — today" drop only, no color
  // flash; issue #1257 finding C). A pool that DID trip today resolves
  // slate→amber, meaningful new info and matching the pre-SSR behavior.
  const activeToday = tripsToday.kind === "count";
  const lastTripTs = cfg.lastTripAt;
  // SSR-safe relative label + title (mirrors the header's `createdRelative`
  // pattern and rebalance-status-value.tsx's `LastRebalanceSubtitle`,
  // hooks/use-now-seconds.ts): the SSR prefetch's fallbackData now paints
  // this panel's real content on first paint for pools with a trip-able
  // breaker (issue #1237), so a plain `relativeTime`/`formatTimestamp` read
  // at render time could disagree between the page's ISR-cached bake time
  // (UTC) and the viewer's hydration clock (local tz/locale). Both hooks
  // render a deterministic UTC value on the server + hydration render, then
  // the live locale-formatted value after mount.
  const lastTripRelative = useSsrSafeRelative(lastTripTs);
  const lastTripTitle = useSsrSafeTimestamp(lastTripTs);
  return (
    <div>
      <dt className="text-slate-400 flex items-center justify-between gap-1">
        <span>Last trip</span>
        {tripped && lastTripTs && (
          <span className="text-xs font-normal text-red-400">
            tripped {lastTripRelative}
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
            title={lastTripTitle}
          >
            {lastTripRelative}
          </a>
        ) : (
          <span className="text-slate-500">never</span>
        )}
        <span
          className={`text-xs ${activeToday ? "text-amber-300" : "text-slate-500"}`}
        >
          {cfg.tripCountLifetime} lifetime
          {/* Pre-mount (clock pending, see tripsTodayDisplay) reserve the
              today-suffix slot with a neutral "· — today" so the real
              "· N today" can't pop in post-mount and grow/wrap the header
              (issue #1257). Resolves to the count, or drops when zero. */}
          {tripsToday.kind === "pending" && " · — today"}
          {tripsToday.kind === "count" && ` · ${tripsToday.count} today`}
        </span>
      </dd>
    </div>
  );
}

function ResetPathBanner({
  cooldownRemainingSec,
  rateInBand,
  liveDelta,
  presentation,
}: {
  cooldownRemainingSec: number | null;
  rateInBand: boolean;
  liveDelta: bigint | null;
  presentation: BreakerPresentation;
}): React.ReactElement {
  // `cooldownRemainingSec === null` pre-mount (see BreakerPanel's `now`
  // state) doesn't tell us whether the on-chain cooldown is still active or
  // has already elapsed — asserting either would misstate reset readiness
  // for a TRIPPED breaker whose cooldown already ended before mount. Render
  // a state-neutral "—" instead of guessing ✓/✗; the real state lands once
  // the ticker's first tick resolves `now`.
  const cooldownElapsed = cooldownRemainingSec === 0;
  return (
    <div className="mt-4 rounded border border-red-900/40 bg-red-950/30 px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
      <span className="text-red-300 font-medium">Reset path</span>
      <span className="inline-flex items-center gap-1">
        <span
          className={
            cooldownRemainingSec === null
              ? "text-slate-500"
              : cooldownElapsed
                ? "text-emerald-300"
                : "text-red-300"
          }
        >
          {cooldownRemainingSec === null ? "—" : cooldownElapsed ? "✓" : "✗"}
        </span>
        Cooldown
        <span
          className={`font-mono ${
            cooldownRemainingSec === null
              ? "text-slate-500"
              : cooldownElapsed
                ? "text-emerald-300"
                : "text-amber-300"
          }`}
        >
          {cooldownRemainingSec === null
            ? "—"
            : cooldownElapsed
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

export function BreakerPanel({
  pool,
  initialBreakerConfig,
}: Props): React.ReactElement | null {
  const { network } = useNetwork();
  const isVirtual = isVirtualPool(pool);
  const rateFeedID = pool.referenceRateFeedID ?? "";

  const { data, isLoading, error } = useGQL<Response>(
    breakerConfigQuery(isVirtual, rateFeedID),
    {
      chainId: pool.chainId,
      rateFeedID,
    },
    undefined,
    // Bound the revalidation so a stalled fetch surfaces as `error` (→
    // stale-refresh notice + retry) instead of pinning the SSR fallback
    // forever — see BREAKER_CONFIG_TIMEOUT_MS. Must match every sibling
    // subscriber (SWR dedup owns one fetcher).
    {
      fallbackData: initialBreakerConfig,
      timeoutMs: BREAKER_CONFIG_TIMEOUT_MS,
    },
  );

  const configs = data?.BreakerConfig ?? [];
  const trips = data?.BreakerTripEvent ?? [];
  const cfg = pickTrippableConfig(configs);
  const tripped = cfg?.status === "TRIPPED";
  const queryPending = isBreakerConfigQueryPending(
    isVirtual,
    rateFeedID,
    data,
    isLoading,
  );
  // The 1-second ticker only matters during cooldown (it drives the
  // countdown text + the reset-path "elapsed" check). Healthy state shows
  // static text — skip the interval to avoid recurring re-renders for nothing.
  const tickerActive = !!cfg && tripped;

  // SSR-safe wall clock for the "trips today" UTC-midnight boundary (below):
  // null on the server + hydration render (see useNowSeconds) so a
  // statically-cached page can't bake in a midnight boundary the viewer's
  // hydration render disagrees with — this panel now renders real content,
  // not a skeleton, on that first pass once fallbackData is present (issue
  // #1237). Separate from the 1-second `now` ticker below, which only drives
  // the tripped-cooldown countdown.
  const todayNowSeconds = useNowSeconds();

  // SSR-safe cooldown ticker (see cooldownRemainingSecFrom below for why
  // `null` and not `Date.now()`). Only ever written from inside the interval
  // callback (never synchronously in the effect body), so the first real
  // value lands with the first 1s tick after mount.
  const [now, setNow] = useState<number | null>(null);
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

  if (queryPending) return <BreakerPanelSkeleton />;
  // Fetch failed with NO data to fall back on — `initialBreakerConfig` absent
  // (SSR missed / age-gated / feed changed) AND the bounded client fetch errored
  // (`data` undefined, `error` set, not loading). The `!cfg` return below would
  // otherwise make the panel silently vanish, indistinguishable from a feed with
  // genuinely no trip-able breaker. Surface an explicit "unavailable" state
  // (distinct from the stale "last confirmed state" affordance, which needs
  // last-known data). Gated on `error` + a feed that WOULD query so a resolved
  // feed with no trip-able breaker still renders null (issue #1257).
  if (isBreakerFetchUnavailable(isVirtual, rateFeedID, data, error))
    return <BreakerUnavailableNotice />;
  // With the SSR prefetch's fallbackData present (issue #1237), `queryPending`
  // is false on first paint, so a pool that resolves to no trip-able breaker
  // renders null directly — no skeleton→null collapse. The shimmer above only
  // shows on the degraded path (prefetch missed) while the client query runs.
  if (isVirtual || !rateFeedID || !cfg) return null;
  // No trip-able breaker (e.g. feed not registered with BreakerBox) → no panel.

  const { cooldownRemainingSec, liveDelta, presentation, liveBar, rateInBand } =
    deriveBreakerView(cfg, now, tripped);
  const tripsToday = tripsTodayDisplay(
    todayNowSeconds,
    trips,
    cfg.breaker.address,
  );

  return (
    <>
      <div className="my-5 h-px bg-slate-800" />
      {/* Disclose a failed revalidation while showing fallback data (issue
          #1257) — see StaleRefreshNotice. The global DataFreshnessBanner still
          covers pools with no trip-able breaker (this strip renders null). */}
      <StaleRefreshNotice
        subject="Breaker status"
        error={error}
        className="mb-4"
      />
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
          cooldownRemainingSec={cooldownRemainingSec}
          rateInBand={rateInBand}
          liveDelta={liveDelta}
          presentation={presentation}
        />
      )}
    </>
  );
}

// Explicit "couldn't load" state for a feed that WOULD have a breaker but whose
// config fetch failed with no fallback (see BreakerPanel). Distinct from the
// stale-refresh notice ("showing the last confirmed state" — that has data) and
// from the null no-panel case (a feed with genuinely no trip-able breaker).
function BreakerUnavailableNotice(): React.ReactElement {
  return (
    <>
      <div className="my-5 h-px bg-slate-800" />
      <ErrorBox message="Breaker status unavailable — couldn't load its current state." />
    </>
  );
}

const BREAKER_SKELETON_SHIMMER = "animate-pulse rounded bg-slate-800/50";

// Mirrors the real panel's shape once a trip-able breaker resolves: a
// hairline divider (`my-5 h-px`) plus the 5-stat `<dl>` grid (Breaker,
// Reference vs Actual, Threshold/Cooldown, live-Δ bar, Last trip) — each
// stat is a label line over a two-line value block, matching `dt` + `dd
// flex flex-col gap-0.5` in the real metric components above.
//
// Cell height: loaded breaker cells render three lines (label, value,
// sub-line — e.g. "Breaker ⓘ" / "MedianDelta" / "trading mode 0") measuring
// 78px in production, taller than a tight 3-line stack. Pin each placeholder
// cell to that height so the breaker `<dl>` doesn't grow once BreakerConfig
// resolves.
function BreakerPanelSkeleton() {
  return (
    <>
      <div className="my-5 h-px bg-slate-800" />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div
            key={`breaker-skel-stat-${i}`}
            className="flex h-[78px] flex-col justify-between"
          >
            <div className={`h-3 w-24 ${BREAKER_SKELETON_SHIMMER}`} />
            <div className={`h-4 w-20 ${BREAKER_SKELETON_SHIMMER}`} />
            <div className={`h-3 w-16 ${BREAKER_SKELETON_SHIMMER}`} />
          </div>
        ))}
      </dl>
    </>
  );
}
