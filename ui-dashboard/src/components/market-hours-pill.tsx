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
import { BREAKER_CONFIG_TIMEOUT_MS } from "@/lib/hasura-timeout";
import type { BreakerConfig, Pool } from "@/lib/types";
import { isVirtualPool } from "@/lib/types";
import { useNowSeconds } from "@/hooks/use-now-seconds";
import { StaleRefreshNotice } from "@/components/feedback";

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
  // Open/closed is genuinely UNKNOWN: the clock is unresolved (SSR + hydration
  // render) AND the on-chain breaker isn't tripped, so whether the market is
  // open depends on the not-yet-known weekend calendar. Must NOT default to
  // "open" (issue #1257 — a weekend the clock hasn't revealed would render a
  // false "Market Open"). Renders a neutral state until the clock resolves.
  unknown: boolean;
  open: boolean;
  imminentClose: boolean;
  secondsUntilTransition: number;
  // Closed-pill suffix text: the scheduled reopen countdown for calendar
  // weekends, else a neutral "—" (weekday/holiday breaker closure, or the
  // pre-clock breaker-closed render where the reopen ETA isn't known yet).
  countdownText: string;
};

/** Derives the open/closed/countdown state from a (possibly not-yet-known)
 * wall clock and the breaker-driven closure flag. `now === null` means the
 * server render or the client's hydration render (see useNowSeconds).
 *
 * Market open/closed is CLOCK-dependent (the weekend calendar), so it cannot be
 * known at SSR — and must not be guessed as "open". Pre-clock we only KNOW the
 * market is closed when the on-chain breaker says so (`breakerClosed`, from
 * SSR-prefetched fallback data, identical on server + hydration renders);
 * otherwise the state is `unknown` and renders neutral until the clock resolves
 * on mount (issue #1257). The suffix (`countdownText`) is likewise neutral "—"
 * whenever the scheduled reopen isn't a known calendar weekend. */
function deriveMarketHoursState(
  now: Date | null,
  breakerClosed: boolean,
): MarketHoursState {
  const calendarClosed = now !== null && isWeekend(now);
  const open = !breakerClosed && !calendarClosed;
  const unknown = now === null && !breakerClosed;
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
  const countdownText = calendarClosed
    ? `${formatHoursMinutes(secondsUntilTransition)} until open`
    : "—";
  return {
    unknown,
    open,
    imminentClose,
    secondsUntilTransition,
    countdownText,
  };
}

type PillView = {
  bgClass: string;
  label: string;
  labelClass: string;
  suffix: string | null;
  suffixClass: string;
};

/** Maps the derived state to the pill's visual descriptor (bg + label + suffix
 * + colors) so MarketHoursPill's render is a single path (keeps its cyclomatic
 * complexity under the repo's ESLint budget). */
function pillView(state: MarketHoursState): PillView {
  const {
    unknown,
    open,
    imminentClose,
    secondsUntilTransition,
    countdownText,
  } = state;
  if (unknown) {
    // Neutral "unknown" pill (issue #1257): the em-dash marks a not-yet-known
    // state, consistent with this file's other pre-clock "—" placeholders —
    // never a false "Market Open".
    return {
      bgClass: "bg-slate-800/80",
      label: "Market —",
      labelClass: "text-slate-400",
      suffix: null,
      suffixClass: "",
    };
  }
  if (!open) {
    return {
      bgClass: "bg-slate-800/80",
      label: "Market Closed",
      labelClass: "text-slate-300",
      suffix: countdownText,
      suffixClass: "text-slate-300",
    };
  }
  if (imminentClose) {
    return {
      bgClass: "bg-amber-900/40",
      label: "Market Open",
      labelClass: "text-amber-300",
      suffix: `${formatHoursMinutes(secondsUntilTransition)} until close`,
      suffixClass: "text-amber-200",
    };
  }
  return {
    bgClass: "bg-slate-800/80",
    label: "Market Open",
    labelClass: "text-emerald-300",
    suffix: scheduleString(),
    suffixClass: "text-slate-300",
  };
}

// The widest resolved pill form, rendered INVISIBLY inside every pill so the
// pill width is fixed across every state swap — skeleton → neutral → open /
// closed / countdown — and no swap can widen or wrap the flex-wrap header
// (issue #1257: reserve the widest resolved width, not the 1-char "—"). Uses
// the wider label ("Market Closed") and the wider suffix (the schedule string),
// each in its real font (font-medium label + font-mono suffix), so the reserved
// width is a strict upper bound on every real form's rendered width.
function PillWidthReserver(): React.ReactElement {
  return (
    <span
      aria-hidden
      className="invisible col-start-1 row-start-1 inline-flex items-center gap-1 whitespace-nowrap"
    >
      <span className="font-medium">Market Closed</span>
      <span>·</span>
      <span className="font-mono">{scheduleString()}</span>
    </span>
  );
}

/** Pill chrome with a fixed (widest-form-reserved) width. The visible content
 * and the invisible width reserver share one grid cell, so the container sizes
 * to the reserver and content swaps never change the pill width. */
function PillFrame({
  bgClass,
  title,
  children,
}: {
  bgClass: string;
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span
      className={`inline-grid items-center rounded ${bgClass} px-1.5 py-0.5 text-xs cursor-help`}
      title={title}
    >
      <PillWidthReserver />
      <span className="col-start-1 row-start-1 inline-flex items-center gap-1 whitespace-nowrap">
        {children}
      </span>
      <span className="sr-only"> — {title}</span>
    </span>
  );
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

  const { data, isLoading, error } = useGQL<Response>(
    queried ? POOL_BREAKER_CONFIG : null,
    { chainId: pool.chainId, rateFeedID },
    undefined,
    // Bound the revalidation so a stalled fetch surfaces as `error` (→
    // stale-refresh notice + retry), not silent stale state — see
    // BREAKER_CONFIG_TIMEOUT_MS. Must match every sibling subscriber.
    {
      fallbackData: initialBreakerConfig,
      timeoutMs: BREAKER_CONFIG_TIMEOUT_MS,
    },
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
  const view = pillView(deriveMarketHoursState(now, breakerClosed));

  const tooltip =
    "FX pools close on weekends from Fri 21:00 UTC to Sun 23:00 UTC, " +
    "plus major holidays, because they track real-world forex rates.";

  // The pill shares the POOL_BREAKER_CONFIG SWR key with BreakerPanel, so a
  // failed revalidation leaves the last-known Market Open/Closed state on
  // screen while SWR sets `error`. Mirror the breaker panel's stale-refresh
  // affordance (issue #1257) so the pill doesn't read as freshly-confirmed —
  // `w-full` drops it onto its own header-row line. `StaleRefreshNotice`
  // returns null when there's no error, so the healthy DOM is just the pill.
  return (
    <>
      <PillFrame bgClass={view.bgClass} title={tooltip}>
        <span className={`font-medium ${view.labelClass}`}>{view.label}</span>
        {view.suffix !== null && (
          <>
            <span className="text-slate-500">·</span>
            <span className={`font-mono ${view.suffixClass}`}>
              {view.suffix}
            </span>
          </>
        )}
      </PillFrame>
      <StaleRefreshNotice
        subject="Market hours"
        error={error}
        className="w-full"
      />
    </>
  );
}

// Same fixed width + height as the real pill: reuses the pill's invisible width
// reserver inside a pulsing box, so the skeleton → resolved-pill swap (degraded
// prefetch-miss path only) can't widen or wrap the title row either.
function MarketHoursPillSkeleton() {
  return (
    <span
      className="inline-grid animate-pulse items-center rounded bg-slate-800/50 px-1.5 py-0.5 text-xs"
      aria-hidden="true"
    >
      <PillWidthReserver />
    </span>
  );
}
