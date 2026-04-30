"use client";

import { AddressLink } from "@/components/address-link";
import { BreakerPanel } from "@/components/breaker-panel";
import { ChainIcon } from "@/components/chain-icon";
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
import { formatTimestamp, relativeTime } from "@/lib/format";
import { stripChainIdFromPoolId } from "@/lib/pool-id";
import { explorerAddressUrl, tokenSymbol, USDM_SYMBOLS } from "@/lib/tokens";
import type { Pool, TradingLimit } from "@/lib/types";

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
  const isVirtual = pool.source?.includes("virtual");
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
        <Stat
          label={
            <span className="inline-flex items-center gap-1">
              Uptime
              <UptimeInfoIcon pool={pool} />
            </span>
          }
          value={
            isVirtual ? (
              <span className="text-slate-500">—</span>
            ) : (
              <UptimeValue pool={pool} />
            )
          }
        />
        <Stat
          label="Oracle Price"
          value={
            isVirtual ? (
              <span className="text-slate-500">—</span>
            ) : (
              <OraclePriceValue pool={pool} network={network} />
            )
          }
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
            isVirtual || !pool.rebalancerAddress ? (
              <span className="text-slate-500">—</span>
            ) : (
              <RebalanceStatusValue
                pool={pool}
                network={network}
                strategyAddress={pool.rebalancerAddress}
              />
            )
          }
        />
        <DeviationCell pool={pool} network={network} />
      </dl>
      {!isVirtual && (
        <>
          <div className="my-5 h-px bg-slate-800" />
          <PoolConfigPanel pool={pool} />
          <BreakerPanel pool={pool} />
        </>
      )}
    </div>
  );
}
