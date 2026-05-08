"use client";

import { AddressLink } from "@/components/address-link";
import { InfoPopover } from "@/components/info-popover";
import { Stat } from "@/components/stat";
import { relativeTime, truncateAddress } from "@/lib/format";
import { tokenSymbol } from "@/lib/tokens";
import type { Network } from "@/lib/networks";
import type { Pool } from "@/lib/types";
import {
  useV2ExchangeConfig,
  type V2ExchangeConfigDTO,
} from "@/hooks/use-v2-exchange-config";

/**
 * Live v2 BiPoolManager exchange config + reserves panel for VirtualPools.
 * Replaces PoolConfigPanel/BreakerPanel (which apply to FPMM only). Data
 * comes from `/api/v2-exchange-config/[chainId]/[poolAddress]` which extracts
 * the exchangeId from the VP's bytecode and reads BiPoolManager state.
 */
export function V2ExchangePanel({
  pool,
  network,
}: {
  pool: Pool;
  network: Network;
}) {
  const { data, isLoading, error } = useV2ExchangeConfig(pool);

  // Skeleton until first response. Errors fall back to a one-line note —
  // the panel is informational, not load-bearing for the rest of the page.
  if (isLoading) return <Skeleton />;
  if (error) {
    return (
      <p className="text-sm text-slate-500">
        v2 exchange details unavailable: {error.message}
      </p>
    );
  }
  if (!data) return null;
  if (!data.ok) {
    // The address looked like a VP route but the bytecode pattern didn't
    // match (e.g. very old VP variant or a non-VP contract reused at this
    // URL). Render nothing — we don't want to assert "not a virtual pool"
    // against UI that already classified it as one.
    return null;
  }

  const c = data.config;

  if (c.isDeprecated) {
    return <DeprecatedExchangeNote pool={pool} network={network} config={c} />;
  }

  const sym0 = tokenSymbol(network, pool.token0);
  const sym1 = tokenSymbol(network, pool.token1);
  // FixidityLib uses 1e24 precision — 5e21 = 0.5% = 50 bps.
  const spreadBps = (Number(c.spread) / 1e24) * 10000;
  const resetMins = Number(c.referenceRateResetFrequency) / 60;

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
        title={`spread = ${c.spread} (FixidityLib 1e24)`}
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
        value={c.pricingModuleName}
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
            : `${c.referenceRateResetFrequency}s`
        }
        mono
      />
      <Stat
        label={`Bucket — ${sym0}`}
        value={formatBucket(c.bucket0, pool.token0Decimals ?? 18)}
        title={`raw bucket0 = ${c.bucket0} (${pool.token0Decimals}d)`}
        mono
      />
      <Stat
        label={`Bucket — ${sym1}`}
        value={formatBucket(c.bucket1, pool.token1Decimals ?? 18)}
        title={`raw bucket1 = ${c.bucket1} (${pool.token1Decimals}d)`}
        mono
      />
      <Stat
        label="Last Reset"
        value={relativeTime(c.lastBucketUpdate)}
        title={c.lastBucketUpdate}
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
            address={c.referenceRateFeedID}
            readOnly
            chainId={pool.chainId}
          />
        }
      />
      <Stat
        label="Exchange ID"
        value={
          <span title={c.exchangeId} className="font-mono">
            {truncateAddress(c.exchangeId)}
          </span>
        }
      />
      <Stat
        label="BiPoolManager"
        value={
          <AddressLink
            address={c.exchangeProvider}
            readOnly
            chainId={pool.chainId}
          />
        }
      />
    </dl>
  );
}

/** Compact bucket reserves: whole tokens with thousands separators. We
 *  drop the fractional part entirely — bucket sizes are quoted in millions
 *  in practice, so two decimal places of token-wei is just noise. */
function formatBucket(rawWei: string, decimals: number): string {
  if (!rawWei || rawWei === "0") return "0";
  const whole = Number(rawWei) / 10 ** decimals;
  return whole.toLocaleString(undefined, {
    maximumFractionDigits: 0,
  });
}

function Skeleton() {
  return <div className="h-12 animate-pulse rounded-md bg-slate-800/40" />;
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
