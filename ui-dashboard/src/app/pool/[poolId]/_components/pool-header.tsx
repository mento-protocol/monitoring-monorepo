"use client";

import { AddressLink } from "@/components/address-link";
import { BreakerPanel } from "@/components/breaker-panel";
import { ChainIcon } from "@/components/chain-icon";
import { InfoPopover } from "@/components/info-popover";
import { MarketHoursPill } from "@/components/market-hours-pill";
import { useNetwork } from "@/components/network-provider";
import { PoolConfigPanel } from "@/components/pool-config-panel";
import { DeviationCell } from "@/components/pool-header/deviation-cell";
import { LimitStatusValue } from "@/components/pool-header/limit-status-value";
import { OraclePriceValue } from "@/components/pool-header/oracle-price-value";
import { RebalanceStatusValue } from "@/components/pool-header/rebalance-status-value";
import {
  UptimeInfoIcon,
  UptimeValue,
} from "@/components/pool-header/uptime-value";
import { SourceBadge } from "@/components/badges";
import { Stat } from "@/components/stat";
import { useGQL } from "@/lib/graphql";
import { formatTimestamp, relativeTime } from "@/lib/format";
import type { Network } from "@/lib/networks";
import { stripChainIdFromPoolId } from "@/lib/pool-id";
import { POOL_V2_EXCHANGE } from "@/lib/queries";
import { explorerAddressUrl, tokenSymbol, USDM_SYMBOLS } from "@/lib/tokens";
import {
  isVirtualPool,
  type BiPoolExchangeRow,
  type Pool,
  type TradingLimit,
} from "@/lib/types";
import { PoolLifecyclePanel } from "./pool-lifecycle-panel";
import { V2ExchangePanel } from "./v2-exchange-panel";

export function PoolHeader({
  pool,
  deployTxHash,
  tradingLimits,
  tradingLimitsError = false,
}: {
  pool: Pool;
  deployTxHash?: string;
  tradingLimits: TradingLimit[];
  tradingLimitsError?: boolean;
}) {
  const { network } = useNetwork();
  const isVirtual = isVirtualPool(pool);
  // Single subscription point for v2 exchange state — children consume via
  // props so SWR (under useGQL) has one subscriber, not three. Skip the
  // query entirely on FPMM pools to avoid a wasted round-trip.
  const {
    data: v2Data,
    isLoading: v2Loading,
    error: v2Error,
  } = useGQL<{ BiPoolExchange: BiPoolExchangeRow[] }>(
    isVirtual ? POOL_V2_EXCHANGE : null,
    { poolId: pool.id, chainId: pool.chainId },
  );
  const v2Config = v2Data?.BiPoolExchange?.[0] ?? null;
  // The Hasura "field not found" error during the indexer deploy+resync
  // window collapses to `v2Error`; surface as a degraded panel rather
  // than silently rendering nothing.
  const v2HasError = v2Error !== undefined;
  // pool.id is the namespaced multichain ID ("42220-0x…"). Strip the chain
  // prefix so AddressLink receives a plain hex address for explorer links.
  const poolContractAddress = stripChainIdFromPoolId(pool.id);

  // Mirror poolName's USDm-last ordering so the linked title matches the
  // breadcrumb and historical display, but keep each symbol as a separate
  // anchor to its token contract on the explorer.
  const sym0 = tokenSymbol(network, pool.token0);
  const sym1 = tokenSymbol(network, pool.token1);
  const usdmIsToken0 = USDM_SYMBOLS.has(sym0) && !USDM_SYMBOLS.has(sym1);
  const firstSym = usdmIsToken0 ? sym1 : sym0;
  const firstAddr = usdmIsToken0 ? pool.token1 : pool.token0;
  const secondSym = usdmIsToken0 ? sym0 : sym1;
  const secondAddr = usdmIsToken0 ? pool.token0 : pool.token1;
  const titleSymbol = (sym: string, addr: string | null) =>
    addr ? (
      <a
        href={explorerAddressUrl(network, addr)}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-indigo-300 transition-colors"
      >
        {sym}
      </a>
    ) : (
      sym
    );

  const createdRelative = relativeTime(pool.createdAtTimestamp);
  const createdTitle = formatTimestamp(pool.createdAtTimestamp);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h1 className="text-xl font-bold text-white">
          {titleSymbol(firstSym, firstAddr)}/
          {titleSymbol(secondSym, secondAddr)}
        </h1>
        <ChainIcon network={network} size={20} />
        <span className="text-sm">
          <AddressLink address={poolContractAddress} readOnly />
        </span>
        <SourceBadge source={pool.source} />
        {v2Config?.isDeprecated && (
          <span className="rounded-full border border-amber-700/40 bg-amber-900/20 px-2 py-0.5 text-xs font-medium text-amber-300">
            Deprecated
          </span>
        )}
        <MarketHoursPill pool={pool} />
        {deployTxHash ? (
          <a
            href={`${network.explorerBaseUrl}/tx/${deployTxHash}`}
            target="_blank"
            rel="noopener noreferrer"
            title={createdTitle}
            className="ml-auto text-xs text-slate-500 hover:text-indigo-400 transition-colors"
          >
            Created {createdRelative}
          </a>
        ) : (
          <span className="ml-auto text-xs text-slate-500" title={createdTitle}>
            Created {createdRelative}
          </span>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm sm:grid-cols-3 lg:grid-cols-5">
        {isVirtual ? (
          <VirtualPoolHeaderTiles
            pool={pool}
            network={network}
            v2Config={v2Config}
            hasError={v2HasError}
          />
        ) : (
          <>
            <Stat
              label={
                <span className="inline-flex items-center gap-1">
                  Uptime
                  <UptimeInfoIcon pool={pool} />
                </span>
              }
              value={<UptimeValue pool={pool} />}
            />
            <Stat
              label="Oracle Price"
              value={<OraclePriceValue pool={pool} network={network} />}
            />
            <Stat
              label="Trading Limits"
              value={
                <LimitStatusValue
                  pool={pool}
                  tradingLimits={tradingLimits}
                  hasError={tradingLimitsError}
                />
              }
            />
            <Stat
              label="Rebalance Status"
              value={
                pool.rebalancerAddress ? (
                  <RebalanceStatusValue
                    pool={pool}
                    network={network}
                    strategyAddress={pool.rebalancerAddress}
                  />
                ) : (
                  <span className="text-slate-500">—</span>
                )
              }
            />
            <DeviationCell pool={pool} network={network} />
          </>
        )}
      </dl>
      {isVirtual ? (
        <>
          <div className="my-5 h-px bg-slate-800" />
          <V2ExchangePanel
            pool={pool}
            network={network}
            v2Config={v2Config}
            isLoading={v2Loading}
            hasError={v2HasError}
          />
          <div className="my-5 h-px bg-slate-800" />
          <PoolLifecyclePanel pool={pool} />
        </>
      ) : (
        <>
          <div className="my-5 h-px bg-slate-800" />
          <PoolConfigPanel pool={pool} />
          <BreakerPanel pool={pool} />
        </>
      )}
    </div>
  );
}

// Status pill style — keyed off the resolved exchange state so the same
// table drives label + color consistently. `null` v2Config means "still
// loading" (treated as "—" so the badge doesn't briefly flash "Active"
// for a deprecated pool while SWR is fetching). `error` covers both
// hook-level fetch failures and structured `ok:false` responses from the
// route — operators see a distinct "—" + tooltip rather than a perpetual
// loading state.
const STATUS_TILE = {
  loading: { label: "—", color: "text-slate-500" },
  active: { label: "Active", color: "text-emerald-300" },
  deprecated: { label: "Deprecated", color: "text-amber-300" },
  error: { label: "—", color: "text-rose-400" },
} as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function statusKey(
  v2Config: BiPoolExchangeRow | null,
  hasError: boolean,
): keyof typeof STATUS_TILE {
  if (hasError) return "error";
  if (!v2Config) return "loading";
  if (v2Config.isDeprecated) return "deprecated";
  // Zero-feed sentinel = stub row from a transient ExchangeCreated RPC
  // miss; same "indexer hasn't fully linked the exchange yet" UX as the
  // panel's `V2ExchangeSyncingNote`. Without this, the header tile would
  // say "Active" while the panel renders the syncing note — confusing
  // operators about whether the v2 exchange is actually live.
  if (v2Config.referenceRateFeedID === ZERO_ADDRESS) return "loading";
  return "active";
}

/**
 * Header KPIs for VirtualPools. The v3 metrics (uptime, oracle, deviation,
 * trading limits, rebalance) are FPMM-only — virtual pools wrap a v2
 * BiPoolManager exchange where those concepts don't apply. Show pair
 * activity instead: lifetime swap count via the wrapper, age, and the
 * underlying exchange status (active/deprecated/error).
 */
function VirtualPoolHeaderTiles({
  pool,
  network,
  v2Config,
  hasError,
}: {
  pool: Pool;
  network: Network;
  v2Config: BiPoolExchangeRow | null;
  hasError: boolean;
}) {
  const status = STATUS_TILE[statusKey(v2Config, hasError)];
  // Render Oracle Price for VPs only when the feedID is populated. The
  // Phase 2 indexer mirrors `BiPoolExchange.referenceRateFeedID` onto the
  // wrapped Pool's `referenceRateFeedID` (forward + reverse links from
  // VirtualPoolDeployed and BiPoolManager.ExchangeCreated handlers), so
  // SortedOracles writes `oraclePrice` / `oracleTimestamp` on every
  // OracleReported / MedianUpdated event. Until the link lands the field
  // is empty and the tile would render "—" — the empty-string gate hides
  // the dead tile in that pre-link interval. `OraclePriceValue` itself
  // renders the staleness color + tooltip the same as the FPMM path.
  const hasOracleFeed = !!pool.referenceRateFeedID;
  return (
    <>
      <Stat
        label="v2 Exchange Status"
        value={
          <span
            className={status.color}
            title={hasError ? "Failed to load v2 exchange config" : undefined}
          >
            {status.label}
          </span>
        }
      />
      <Stat
        label={
          <span className="inline-flex items-center gap-1">
            Wrapper Swaps
            <InfoPopover
              label="Wrapper Swaps"
              content="Lifetime swap count for the v3 Router → VirtualPool wrapper only. Direct v2-broker swaps on the same trading pair (the majority of activity) are not included — combined-activity panel ships in a follow-up."
            />
          </span>
        }
        value={(pool.swapCount ?? 0).toLocaleString()}
        mono
      />
      {hasOracleFeed ? (
        <Stat
          label="Oracle Price"
          value={<OraclePriceValue pool={pool} network={network} />}
        />
      ) : null}
    </>
  );
}
