"use client";

import { toHumanUnits } from "@mento-protocol/monitoring-config/units";
import { AddressLink } from "@/components/address-link";
import { InfoPopover } from "@/components/info-popover";
import { Stat } from "@/components/stat";
import { relativeTime, truncateAddress } from "@/lib/format";
import { tokenSymbol } from "@/lib/tokens";
import type { Network } from "@/lib/networks";
import type { Pool } from "@/lib/types";
import type { V2ExchangeConfigDTO } from "@/hooks/use-v2-exchange-config";

/**
 * Live v2 BiPoolManager exchange config + reserves panel for VirtualPools.
 * Replaces PoolConfigPanel/BreakerPanel (which apply to FPMM only). Data
 * comes from `/api/v2-exchange-config/[chainId]/[poolAddress]` which extracts
 * the exchangeId from the VP's bytecode and reads BiPoolManager state.
 */
export function V2ExchangePanel({
  pool,
  network,
  v2Config,
  isLoading,
  hasError = false,
  errorReason,
}: {
  pool: Pool;
  network: Network;
  v2Config: V2ExchangeConfigDTO | null;
  isLoading: boolean;
  /** True when the route returned 502, threw, or returned `ok: false`. */
  hasError?: boolean;
  /** When the route returned `ok: false`, the structured reason string. */
  errorReason?: "no_bytecode" | "not_a_virtual_pool" | "rpc_failed";
}) {
  // Skeleton until first response.
  if (isLoading) return <Skeleton />;
  // Surface failure explicitly. Without this, an upstream RPC outage or a VP
  // variant whose bytecode the resolver doesn't recognize would render nothing
  // — operators can't distinguish "no data yet" from "fetch failed", and
  // critical state like deprecation/buckets goes silently absent.
  if (hasError) {
    return <V2ExchangeErrorNote reason={errorReason} />;
  }
  if (!v2Config) return null;

  if (v2Config.isDeprecated) {
    return (
      <DeprecatedExchangeNote pool={pool} network={network} config={v2Config} />
    );
  }

  const sym0 = tokenSymbol(network, pool.token0);
  const sym1 = tokenSymbol(network, pool.token1);
  // FixidityLib uses 1e24 precision — 5e21 = 0.5% = 50 bps.
  const spreadBps = (Number(v2Config.spread) / 1e24) * 10000;
  const resetMins = Number(v2Config.referenceRateResetFrequency) / 60;

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm sm:grid-cols-3 lg:grid-cols-5">
      <Stat
        label={
          <span className="inline-flex items-center gap-1">
            Swap Fee
            <InfoPopover
              label="Swap Fee"
              content="Spread charged on each swap, set on the v2 BiPoolManager exchange that backs this pool."
            />
          </span>
        }
        value={`${spreadBps.toFixed(0)} bps`}
        title={`spread = ${v2Config.spread} (FixidityLib 1e24)`}
        mono
      />
      <Stat
        label={
          <span className="inline-flex items-center gap-1">
            Pricing Curve
            <InfoPopover
              label="Pricing Curve"
              content="Mento v2 pricing module. ConstantSum: zero-slippage swaps within the bucket; buckets reset from the oracle on a fixed cadence."
            />
          </span>
        }
        value={v2Config.pricingModuleName ?? "—"}
      />
      <Stat
        label={
          <span className="inline-flex items-center gap-1">
            Bucket Reset
            <InfoPopover
              label="Bucket Reset Cadence"
              content="How often the v2 exchange refreshes its bucket reserves from the SortedOracles reference rate."
            />
          </span>
        }
        value={
          resetMins >= 1
            ? `${resetMins} min`
            : `${v2Config.referenceRateResetFrequency}s`
        }
        mono
      />
      <Stat
        label={`Bucket — ${sym0}`}
        value={formatBucket(v2Config.bucket0, pool.token0Decimals ?? 18)}
        title={`raw bucket0 = ${v2Config.bucket0} (${pool.token0Decimals}d)`}
        mono
      />
      <Stat
        label={`Bucket — ${sym1}`}
        value={formatBucket(v2Config.bucket1, pool.token1Decimals ?? 18)}
        title={`raw bucket1 = ${v2Config.bucket1} (${pool.token1Decimals}d)`}
        mono
      />
      <Stat
        label="Last Reset"
        value={relativeTime(v2Config.lastBucketUpdate)}
        title={v2Config.lastBucketUpdate}
      />
      <Stat
        label={
          <span className="inline-flex items-center gap-1">
            Oracle Feed
            <InfoPopover
              label="Reference Rate Feed"
              content="SortedOracles feed used to recompute the bucket sizes on each reset."
            />
          </span>
        }
        value={
          <AddressLink
            address={v2Config.referenceRateFeedID}
            readOnly
            chainId={pool.chainId}
          />
        }
      />
      <Stat
        label="Exchange ID"
        value={
          <span title={v2Config.exchangeId} className="font-mono">
            {truncateAddress(v2Config.exchangeId)}
          </span>
        }
      />
      <Stat
        label="BiPoolManager"
        value={
          <AddressLink
            address={v2Config.exchangeProvider}
            readOnly
            chainId={pool.chainId}
          />
        }
      />
    </dl>
  );
}

/** Whole-token bucket display with thousands separators. Uses
 *  `toHumanUnits` (BigInt-safe) rather than naive `Number / 10**decimals`
 *  — buckets routinely sit above 9M tokens at 18 decimals where the
 *  Number conversion starts losing precision. */
function formatBucket(rawWei: string, decimals: number): string {
  if (!rawWei || rawWei === "0") return "0";
  const whole = toHumanUnits(BigInt(rawWei), decimals);
  return whole.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function Skeleton() {
  return <div className="h-12 animate-pulse rounded-md bg-slate-800/40" />;
}

function V2ExchangeErrorNote({
  reason,
}: {
  reason?: "no_bytecode" | "not_a_virtual_pool" | "rpc_failed";
}) {
  const message =
    reason === "no_bytecode"
      ? "No contract code at this address."
      : reason === "not_a_virtual_pool"
        ? "Contract bytecode doesn't match a known VirtualPool layout."
        : "Couldn't load v2 exchange config — upstream RPC error.";
  return (
    <div className="rounded-md border border-rose-700/40 bg-rose-900/10 p-3 text-sm">
      <div className="mb-1 font-medium text-rose-300">
        v2 exchange config unavailable
      </div>
      <p className="text-slate-300">{message}</p>
    </div>
  );
}

function DeprecatedExchangeNote({
  pool,
  network,
  config,
}: {
  pool: Pool;
  network: Network;
  config: V2ExchangeConfigDTO;
}) {
  const sym0 = tokenSymbol(network, pool.token0);
  const sym1 = tokenSymbol(network, pool.token1);
  return (
    <div className="rounded-md border border-amber-700/40 bg-amber-900/10 p-3 text-sm">
      <div className="mb-1 font-medium text-amber-300">
        v2 exchange deprecated
      </div>
      <p className="text-slate-300">
        The {sym0}/{sym1} BiPoolManager exchange has been removed by governance.
        The VirtualPool wrapper remains deployed but routes no traffic. Trading
        data shown below is historical only.
      </p>
      <p className="mt-1 text-xs text-slate-500">
        Exchange id:{" "}
        <span className="font-mono" title={config.exchangeId}>
          {truncateAddress(config.exchangeId)}
        </span>
      </p>
    </div>
  );
}
