"use client";

import {
  FX_CLOSE_DAY,
  FX_CLOSE_HOUR_UTC,
  FX_REOPEN_DAY,
  FX_REOPEN_HOUR_UTC,
  isWeekend,
  nextMarketHoursTransition,
} from "@/lib/weekend";
import { useGQL } from "@/lib/graphql";
import {
  POOL_BREAKER_CONFIG,
  type PoolBreakerConfigResponse,
} from "@/lib/queries";
import type { BreakerConfig, Pool } from "@/lib/types";
import { isVirtualPool } from "@/lib/types";
import { useNowSeconds } from "@/hooks/use-now-seconds";

const COUNTDOWN_THRESHOLD_HOURS = 6;

const WEEKDAY_LABEL = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

/** Format hours as `Hh Mm` for the countdown subtitle. */
function formatHoursMinutes(totalSeconds: number): string {
  if (totalSeconds <= 0) return "0m";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Render the static schedule string `Sun 23:00 → Fri 21:00 UTC` from
 * shared-config so the pill stays in lockstep with the on-chain MarketHours
 * window. Day-of-week labels are derived from FX_CALENDAR rather than
 * hardcoded so a calendar update flows through automatically. */
function scheduleString(): string {
  const open = `${WEEKDAY_LABEL[FX_REOPEN_DAY]} ${pad2(FX_REOPEN_HOUR_UTC)}:00`;
  const close = `${WEEKDAY_LABEL[FX_CLOSE_DAY]} ${pad2(FX_CLOSE_HOUR_UTC)}:00`;
  return `${open} → ${close} UTC`;
}

type Props = {
  pool: Pool;
  /** Server-prefetched breaker config, forwarded to SWR as `fallbackData` so
   *  the pill knows on first paint whether the pool is FX-gated — no
   *  shimmer→null flash for non-FX pools (issue #1237). */
  initialBreakerConfig?: PoolBreakerConfigResponse | undefined;
};

type Response = {
  BreakerConfig: BreakerConfig[];
};

function findEnabledMarketHoursConfig(
  configs: BreakerConfig[] | undefined,
): BreakerConfig | undefined {
  return configs?.find((c) => c.breaker.kind === "MARKET_HOURS" && c.enabled);
}

function isBreakerClosure(config: BreakerConfig | undefined): boolean {
  return config?.status === "TRIPPED" || (config?.tradingMode ?? 0) !== 0;
}

type MarketHoursState = {
  open: boolean;
  calendarClosed: boolean;
  imminentClose: boolean;
  secondsUntilTransition: number;
};

/** Derives the open/closed/countdown state from a (possibly not-yet-known)
 * wall clock and the breaker-driven closure flag. `now === null` means the
 * server render or the client's hydration render (see useNowSeconds) —
 * returns the neutral "assume open, no countdown" state so that render can't
 * disagree with the real state computed here once `now` resolves after
 * mount (issue #1237). */
function deriveMarketHoursState(
  now: Date | null,
  breakerClosed: boolean,
): MarketHoursState {
  const calendarClosed = now !== null && isWeekend(now);
  const open = !breakerClosed && !calendarClosed;
  const transition = now !== null ? nextMarketHoursTransition(now) : null;
  const secondsUntilTransition =
    transition && now !== null
      ? Math.max(
          0,
          Math.floor((transition.at.getTime() - now.getTime()) / 1000),
        )
      : 0;
  const imminentClose =
    now !== null && secondsUntilTransition / 3600 < COUNTDOWN_THRESHOLD_HOURS;
  return { open, calendarClosed, imminentClose, secondsUntilTransition };
}

/**
 * Title-row pill summarising whether the pool's FX market is currently open.
 * Renders only when the pool's rateFeedID is gated by an on-chain
 * MarketHoursBreaker (queried alongside `<BreakerPanel />` and SWR-deduped).
 *
 * Three render modes:
 *   - Open + ≥6h until close: schedule mode (slate bg, emerald label).
 *   - Open + <6h until close: countdown mode (amber bg, amber label).
 *   - Closed: countdown to reopen (slate bg, slate label).
 *
 * Tooltip explains why FX pools close on weekends.
 */
export function MarketHoursPill({
  pool,
  initialBreakerConfig,
}: Props): React.ReactElement | null {
  const isVirtual = isVirtualPool(pool);
  const rateFeedID = pool.referenceRateFeedID ?? "";
  const queried = !isVirtual && !!rateFeedID;

  const { data, isLoading } = useGQL<Response>(
    queried ? POOL_BREAKER_CONFIG : null,
    { chainId: pool.chainId, rateFeedID },
    undefined,
    { fallbackData: initialBreakerConfig },
  );

  // FX-ness: the rateFeedID has an ENABLED MARKET_HOURS BreakerConfig.
  // Stablecoin pools (USDC/USDm, USDT/USDm, axlUSDC/USDm) won't have one.
  // We require `c.enabled === true` so a governance toggle that disables
  // the market-hours breaker for a feed (`BreakerStatusUpdated(..., false)`)
  // also hides the pill — otherwise operators would see a "Market Open/Closed"
  // countdown that no longer reflects the on-chain trading gate.
  const marketHoursConfig = findEnabledMarketHoursConfig(data?.BreakerConfig);
  const enabled = !isVirtual && !!marketHoursConfig;
  // With the SSR prefetch's fallbackData present (issue #1237), `data` is
  // populated on first paint so this is false and the pill renders its resolved
  // shape immediately (real pill or null, no shimmer). It stays true only on
  // the degraded path (prefetch missed) while the client query is in flight, so
  // a late-mounting pill can't push the header card's flex-wrap onto a second
  // line (issue #1222) — the null→content jump becomes placeholder→content.
  const queryPending = queried && data === undefined && isLoading;

  // SSR-safe wall clock (hooks/use-now-seconds.ts): `null` during the server
  // render AND the client's hydration render, then a live value that ticks
  // every ~30s. `now` is read only when non-null (below): the pool-detail
  // page is ISR-cached (`revalidate: 60`) and the SSR fetch's fallbackData
  // now paints real pill content on first paint (issue #1237), so a wall
  // clock read during SSR/hydration can be up to ~60s stale versus the
  // viewer's clock — a near-guaranteed hydration mismatch on open/closed and
  // countdown text, worst on weekends when FX pools are closed. Pre-mount we
  // render the neutral "assume open, no countdown" schedule variant instead;
  // the real state settles in immediately after mount.
  const nowSeconds = useNowSeconds();
  const now = nowSeconds !== null ? new Date(nowSeconds * 1000) : null;

  if (queryPending) return <MarketHoursPillSkeleton />;
  // With the SSR prefetch's fallbackData present (issue #1237), `queryPending`
  // is false on first paint, so a non-FX pool renders null directly — no
  // shimmer→null flash and no title-row flex-wrap jump at any viewport. The
  // shimmer above only shows on the degraded path (prefetch missed).
  if (!enabled) return null;

  const breakerClosed = isBreakerClosure(marketHoursConfig);
  const { open, calendarClosed, imminentClose, secondsUntilTransition } =
    deriveMarketHoursState(now, breakerClosed);

  const tooltip =
    "FX pools close on weekends from Fri 21:00 UTC to Sun 23:00 UTC, " +
    "plus major holidays, because they track real-world forex rates.";

  // Screen readers don't reliably announce `title=`; an `sr-only` span
  // inside the pill exposes the explanation to assistive tech without
  // changing the visual.
  if (!open) {
    // Calendar closure — countdown to next open. Breaker-driven weekday
    // closures do not have a known reopen time in the weekly FX calendar.
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-slate-800/80 px-1.5 py-0.5 text-xs cursor-help"
        title={tooltip}
      >
        <span className="text-slate-300 font-medium">Market Closed</span>
        {calendarClosed && (
          <>
            <span className="text-slate-500">·</span>
            <span className="font-mono text-slate-300">
              {formatHoursMinutes(secondsUntilTransition)} until open
            </span>
          </>
        )}
        <span className="sr-only"> — {tooltip}</span>
      </span>
    );
  }

  if (imminentClose) {
    // Open, but close is imminent — amber countdown.
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-amber-900/40 px-1.5 py-0.5 text-xs cursor-help"
        title={tooltip}
      >
        <span className="text-amber-300 font-medium">Market Open</span>
        <span className="text-slate-500">·</span>
        <span className="font-mono text-amber-200">
          {formatHoursMinutes(secondsUntilTransition)} until close
        </span>
        <span className="sr-only"> — {tooltip}</span>
      </span>
    );
  }

  // Open with plenty of runway — show the static schedule.
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-slate-800/80 px-1.5 py-0.5 text-xs cursor-help"
      title={tooltip}
    >
      <span className="text-emerald-300 font-medium">Market Open</span>
      <span className="text-slate-500">·</span>
      <span className="font-mono text-slate-300">{scheduleString()}</span>
      <span className="sr-only"> — {tooltip}</span>
    </span>
  );
}

// Same box height as the real pill (text-xs line height + py-0.5 ≈ h-5).
// Width approximates the widest real variant ("Market Open · <schedule>")
// so a pool that does turn out FX-gated doesn't visibly widen the title row.
function MarketHoursPillSkeleton() {
  return (
    <span
      className="inline-flex h-5 w-40 animate-pulse items-center rounded bg-slate-800/50"
      aria-hidden="true"
    />
  );
}
