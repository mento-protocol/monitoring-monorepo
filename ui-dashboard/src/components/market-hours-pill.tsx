"use client";

import { useEffect, useState } from "react";
import {
  FX_CLOSE_DAY,
  FX_CLOSE_HOUR_UTC,
  FX_REOPEN_DAY,
  FX_REOPEN_HOUR_UTC,
  isWeekend,
  nextMarketHoursTransition,
} from "@/lib/weekend";
import { useGQL } from "@/lib/graphql";
import { POOL_BREAKER_CONFIG } from "@/lib/queries";
import type { BreakerConfig, Pool } from "@/lib/types";
import { isVirtualPool } from "@/lib/types";

const COUNTDOWN_THRESHOLD_HOURS = 6;
// Aligned to wall-clock seconds (matches Market Hours countdown precision).
const TICK_INTERVAL_MS = 60_000;

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
};

type Response = {
  BreakerConfig: BreakerConfig[];
};

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
export function MarketHoursPill({ pool }: Props): React.ReactElement | null {
  const isVirtual = isVirtualPool(pool);
  const rateFeedID = pool.referenceRateFeedID ?? "";

  const { data } = useGQL<Response>(
    !isVirtual && rateFeedID ? POOL_BREAKER_CONFIG : null,
    { chainId: pool.chainId, rateFeedID },
  );

  // FX-ness: the rateFeedID has an ENABLED MARKET_HOURS BreakerConfig.
  // Stablecoin pools (USDC/USDm, USDT/USDm, axlUSDC/USDm) won't have one.
  // We require `c.enabled === true` so a governance toggle that disables
  // the market-hours breaker for a feed (`BreakerStatusUpdated(..., false)`)
  // also hides the pill — otherwise operators would see a "Market Open/Closed"
  // countdown that no longer reflects the on-chain trading gate.
  const enabled =
    !isVirtual &&
    !!data?.BreakerConfig?.some(
      (c) => c.breaker.kind === "MARKET_HOURS" && c.enabled,
    );

  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      // Round to the minute so re-renders don't fire on every tick when the
      // displayed countdown hasn't changed (the pill renders Hh Mm only).
      setNow((prev) => {
        const next = new Date();
        const prevMinute = Math.floor(prev.getTime() / 60_000);
        const nextMinute = Math.floor(next.getTime() / 60_000);
        return nextMinute !== prevMinute ? next : prev;
      });
    }, TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled]);

  if (!enabled) return null;

  const open = !isWeekend(now);
  const transition = nextMarketHoursTransition(now);
  const secondsUntilTransition = Math.max(
    0,
    Math.floor((transition.at.getTime() - now.getTime()) / 1000),
  );
  const hoursUntilTransition = secondsUntilTransition / 3600;

  const tooltip =
    "FX pools close on weekends from Fri 21:00 UTC to Sun 23:00 UTC, " +
    "plus major holidays, because they track real-world forex rates.";

  // Screen readers don't reliably announce `title=`; an `sr-only` span
  // inside the pill exposes the explanation to assistive tech without
  // changing the visual.
  if (!open) {
    // Closed — countdown to next open.
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-slate-800/80 px-1.5 py-0.5 text-xs cursor-help"
        title={tooltip}
      >
        <span className="text-slate-300 font-medium">Market Closed</span>
        <span className="text-slate-500">·</span>
        <span className="font-mono text-slate-300">
          {formatHoursMinutes(secondsUntilTransition)} until open
        </span>
        <span className="sr-only"> — {tooltip}</span>
      </span>
    );
  }

  if (hoursUntilTransition < COUNTDOWN_THRESHOLD_HOURS) {
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
