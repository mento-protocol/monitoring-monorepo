"use client";

import { LimitBadge } from "@/components/badges";
import { useNetwork } from "@/components/network-provider";
import { PressureBar } from "@/components/pressure-bar";
import {
  useNowSeconds,
  useSsrSafeRelative,
  useSsrSafeTimestamp,
} from "@/hooks/use-now-seconds";
import {
  BROKER_STATE_STALE_SECONDS,
  enabledWindows,
  formatWholeUnits,
  orderRowsByPoolTokens,
  worstRowStatus,
  type BrokerLimitsState,
} from "@/lib/broker-limits";
import { tokenSymbol } from "@/lib/tokens";
import type { BrokerTradingLimitRow, Pool } from "@/lib/types";

const FRESHNESS_NOTE =
  "Re-read from the Broker on swaps for this exchange: on the first swap once " +
  "the stored state is 5 minutes old, and on every swap while pressure is at " +
  "least 80%. Grafana and Aegis poll the same on-chain state every 10 seconds.";

/**
 * Trading Limits panel for a VirtualPool. The wrapper itself has no limits —
 * the v2 Broker enforces them on the BiPoolManager exchange the wrapper routes
 * to, keyed per token leg. Direct v2 swaps move the same limits, so these rows
 * describe the exchange, not the wrapper's own traffic.
 */
export function BrokerLimitPanel({
  pool,
  state,
}: {
  pool: Pool;
  state: BrokerLimitsState;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      {/* One stable live region over the badge and every body branch. The
          branches swap as the poll resolves, so per-branch roles would come
          and go and announce nothing. */}
      <div role="status" aria-live="polite">
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-base font-semibold text-white">Trading Limits</h2>
          <LimitBadge status={worstRowStatus(state.rows)} />
        </div>
        <BrokerLimitBody pool={pool} state={state} />
      </div>
    </div>
  );
}

function BrokerLimitBody({
  pool,
  state,
}: {
  pool: Pool;
  state: BrokerLimitsState;
}) {
  const { network } = useNetwork();
  if (state.hasError) {
    return (
      <p className="text-sm text-red-400">
        Unable to load trading limits — try again later.
      </p>
    );
  }
  if (state.isLoading && state.rows.length === 0) {
    return <BrokerLimitSkeleton />;
  }
  if (state.rows.length === 0) {
    return (
      <p className="text-sm text-slate-400">
        No limit state yet; limits refresh on Broker swaps for this exchange.
      </p>
    );
  }
  const rows = orderRowsByPoolTokens(state.rows, pool.token0, pool.token1);
  return (
    <div className="flex flex-col gap-5">
      {rows.map((row) => (
        <BrokerLimitLeg
          key={row.id}
          row={row}
          symbol={tokenSymbol(network, row.token)}
        />
      ))}
    </div>
  );
}

function BrokerLimitLeg({
  row,
  symbol,
}: {
  row: BrokerTradingLimitRow;
  symbol: string;
}) {
  const windows = enabledWindows(row);
  const formatAmount = (raw: string) => `${formatWholeUnits(raw)} ${symbol}`;
  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs font-medium text-slate-400 uppercase tracking-wide">
        {symbol}
      </div>
      {!row.configKnown ? (
        <DegradedNote text="Limit configuration unavailable, retrying on the next swap." />
      ) : !row.stateKnown ? (
        <DegradedNote text="Baseline state pending — the next Broker swap on this exchange records it." />
      ) : windows.length === 0 ? (
        <DegradedNote text="No limit window is enabled for this token." />
      ) : (
        windows.map((window) => (
          <PressureBar
            key={window.key}
            pressure={window.pressure}
            label={window.label}
            netflow={window.netflow}
            limit={window.limit}
            formatValue={formatAmount}
            tokenSymbol={symbol}
            hint={window.hint}
          />
        ))
      )}
      <BrokerLimitFooter row={row} />
    </div>
  );
}

function DegradedNote({ text }: { text: string }) {
  return <p className="text-sm text-slate-400">{text}</p>;
}

function BrokerLimitFooter({ row }: { row: BrokerTradingLimitRow }) {
  const nowSeconds = useNowSeconds();
  const relative = useSsrSafeRelative(row.stateTimestamp);
  const absolute = useSsrSafeTimestamp(row.stateTimestamp);
  const stateSeconds = Number(row.stateTimestamp);
  const hasState = row.stateKnown && stateSeconds > 0;
  // Ageing is evaluated only against the live clock, so the server render and
  // the hydration render never disagree about the amber treatment.
  const isStale =
    hasState &&
    nowSeconds !== null &&
    nowSeconds - stateSeconds >= BROKER_STATE_STALE_SECONDS;
  // Built from the row's own timestamp, never the clock, and hoisted out of
  // the JSX so the hydration-mismatch lint reads it as static.
  const dateTime = new Date(stateSeconds * 1000).toISOString();

  return (
    <div className="flex flex-col gap-1 text-xs text-slate-500">
      {hasState ? (
        <time
          dateTime={dateTime}
          title={`${absolute} — ${FRESHNESS_NOTE}`}
          className={isStale ? "text-amber-400" : undefined}
        >
          State as of {relative}
        </time>
      ) : (
        <span title={FRESHNESS_NOTE}>State not read yet</span>
      )}
      <span className="font-mono break-all text-slate-600">
        Limit id {row.limitId}
      </span>
    </div>
  );
}

const BROKER_LIMIT_SHIMMER = "animate-pulse rounded bg-slate-800/50";

// Mirrors the loaded shape for the common case — two token legs, one bar each
// — so the panel doesn't collapse from a skeleton into shorter content, and
// never shows the empty-state copy while the query is still in flight.
function BrokerLimitSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      {Array.from({ length: 2 }, (_, tokenIdx) => (
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key
        <div key={`broker-skel-${tokenIdx}`} className="flex flex-col gap-3">
          <div className={`h-3 w-16 ${BROKER_LIMIT_SHIMMER}`} />
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <div className={`h-4 w-32 ${BROKER_LIMIT_SHIMMER}`} />
              <div className={`h-4 w-10 ${BROKER_LIMIT_SHIMMER}`} />
            </div>
            <div className={`h-2 w-full ${BROKER_LIMIT_SHIMMER}`} />
            <div className={`h-3 w-44 ${BROKER_LIMIT_SHIMMER}`} />
          </div>
          <div className={`h-3 w-56 ${BROKER_LIMIT_SHIMMER}`} />
        </div>
      ))}
    </div>
  );
}
