"use client";

import { toHumanUnits } from "@mento-protocol/monitoring-config/units";
import { AddressLink } from "@/components/address-link";
import { InfoPopover } from "@/components/info-popover";
import { Stat } from "@/components/stat";
import { relativeTime, truncateAddress } from "@/lib/format";
import { tokenSymbol } from "@/lib/tokens";
import type { Network } from "@/lib/networks";
import type { BiPoolExchangeRow, Pool } from "@/lib/types";

const BUCKET_INFO_CONTENT =
  "Per-side virtual reserve target on the v2 ConstantSum curve. Distinct from on-chain Reserve liquidity: buckets define the swap-curve sizing for the current reset cycle (refilled from SortedOracles every cycle), while actual settlement debits/credits the Mento Reserve. Bucket size caps the swap that can clear without a wait for the next reset.";

/**
 * Live v2 BiPoolManager exchange config + reserves panel for VirtualPools.
 * Replaces PoolConfigPanel/BreakerPanel (which apply to FPMM only). Data
 * comes from the indexer's `BiPoolExchange` entity via POOL_V2_EXCHANGE
 * (joined to this pool by `wrappedByPoolId`).
 */
export function V2ExchangePanel({
  pool,
  network,
  v2Config,
  isLoading,
  hasError = false,
}: {
  pool: Pool;
  network: Network;
  v2Config: BiPoolExchangeRow | null;
  isLoading: boolean;
  /** True when the GraphQL query threw / returned an error. */
  hasError?: boolean;
}) {
  if (isLoading) return <Skeleton />;
  if (hasError) return <V2ExchangeErrorNote />;
  // Distinguish "still loading" (skeleton above) from "indexer hasn't seen
  // this VP's underlying exchange yet" (no row joined). At sync-tip every
  // active VP self-heals on its first event after start_block, so this only
  // shows transiently right after a VP is deployed (or for a pool whose
  // wrapped exchange is destroyed without an `ExchangeDestroyed` event in
  // our window). Worth surfacing rather than rendering nothing — operators
  // shouldn't have to guess whether the panel is empty by design or broken.
  if (!v2Config) return <V2ExchangeSyncingNote />;
  // Deprecated takes priority over the zero-feed syncing sentinel: an
  // exchange that was destroyed before its config landed (or seeded only
  // from the Destroyed event params) will have isDeprecated=true AND a
  // zero feedID. The amber governance-removal callout is the right
  // operator signal in that case, not "still syncing".
  if (v2Config.isDeprecated) {
    return (
      <DeprecatedExchangeNote pool={pool} network={network} config={v2Config} />
    );
  }
  // ExchangeCreated wrote a stub row when `poolExchangeEffect` failed
  // (zero-feed sentinel). Indexer-side stub-retry kicks in on the next
  // bucket / spread event but until then the row would render as "0 bps,
  // 0 buckets, 1970 last reset" — misleading during the deploy/RPC window
  // the new isolated GraphQL query is meant to degrade through. Treat the
  // zero-feed signature as "syncing" same as a missing row.
  if (
    v2Config.referenceRateFeedID ===
    "0x0000000000000000000000000000000000000000"
  ) {
    return <V2ExchangeSyncingNote />;
  }

  const sym0 = tokenSymbol(network, pool.token0);
  const sym1 = tokenSymbol(network, pool.token1);
  // FixidityLib uses 1e24 precision — 5e21 = 0.5% = 50 bps. BigInt math
  // before the Number conversion: production spreads (1e21–1e23) sit
  // above Number.MAX_SAFE_INTEGER (~9e15), so naive `Number(spread)/1e24`
  // would drop low-bit precision. Bps result fits in a safe Number.
  // ES2017 tsconfig target → use BigInt() constructor instead of `Nn` literals.
  const spreadBps = Number(
    (BigInt(v2Config.spread) * BigInt(10000)) /
      BigInt("1000000000000000000000000"),
  );
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
        label={
          <span className="inline-flex items-center gap-1">
            Bucket — {sym0}
            <InfoPopover
              label="Bucket reserves"
              content={BUCKET_INFO_CONTENT}
            />
          </span>
        }
        value={formatBucket(v2Config.bucket0, pool.token0Decimals ?? 18)}
        title={`raw bucket0 = ${v2Config.bucket0} (${pool.token0Decimals}d)`}
        mono
      />
      <Stat
        label={
          <span className="inline-flex items-center gap-1">
            Bucket — {sym1}
            <InfoPopover
              label="Bucket reserves"
              content={BUCKET_INFO_CONTENT}
            />
          </span>
        }
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

function V2ExchangeSyncingNote() {
  return (
    <div className="rounded-md border border-slate-700/40 bg-slate-900/40 p-3 text-sm">
      <div className="mb-1 font-medium text-slate-300">
        v2 exchange data syncing
      </div>
      <p className="text-slate-400">
        The indexer has not yet linked this VirtualPool to its underlying v2
        BiPoolManager exchange. Self-heal runs on the next bucket-update or swap
        event for this pool — typically within ~6 minutes of catching up to
        head.
      </p>
    </div>
  );
}

function V2ExchangeErrorNote() {
  return (
    <div className="rounded-md border border-rose-700/40 bg-rose-900/10 p-3 text-sm">
      <div className="mb-1 font-medium text-rose-300">
        v2 exchange config unavailable
      </div>
      <p className="text-slate-300">
        Could not load the v2 BiPoolManager exchange data for this VirtualPool —
        upstream GraphQL error or the indexer has not synced the BiPoolExchange
        entity yet.
      </p>
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
  config: BiPoolExchangeRow;
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
