"use client";

import Link from "next/link";
import { useMemo } from "react";
import { AddressLink } from "@/components/address-link";
import { useNetwork } from "@/components/network-provider";
import { EmptyBox, ErrorBox, Skeleton, Tile } from "@/components/feedback";
import { Table, Row, Th, Td } from "@/components/table";
import { useGQL } from "@/lib/graphql";
import {
  CDP_INSTANCE_DAILY_SNAPSHOTS,
  CDP_MARKET_DETAIL,
  CDP_MARKETS,
} from "@/lib/queries";
import { buildPoolDetailHref } from "@/lib/routing";
import { formatWei, relativeTime, truncateAddress } from "@/lib/format";
import type { Network } from "@/lib/networks";
import { explorerAddressUrl } from "@/lib/tokens";
import {
  CDP_TROVES_LIST_LIMIT,
  type CdpCollateral,
  type CdpDepositor,
  type CdpInstance,
  type CdpInstanceDailySnapshot,
  type CdpPoolRow,
  type CdpTrove,
  type CdpTroveListRow,
} from "../../_lib/types";
import { cdpSymbolSlug, formatTokenAmount } from "../../_lib/format";
import { aggregateTroves, deriveCdpHealth } from "../../_lib/health";
import { CdpHealthBadge } from "../../_components/cdp-health-badge";
import { CdpStabilityPoolTvlChart } from "./cdp-stability-pool-tvl-chart";
import { CdpTransactionsTable } from "./cdp-transactions-table";

type CdpMarketsResponse = {
  LiquityCollateral: CdpCollateral[];
  LiquityInstance: CdpInstance[];
  Trove: CdpTroveListRow[];
};

type CdpDetailResponse = {
  LiquityCollateral: CdpCollateral[];
  LiquityInstance: CdpInstance[];
  Trove: CdpTrove[];
  StabilityPoolDepositor: CdpDepositor[];
  CdpPool: CdpPoolRow[];
};

type CdpDailySnapshotsResponse = {
  LiquityInstanceDailySnapshot: CdpInstanceDailySnapshot[];
};

export function CdpDetailClient({ symbol }: { symbol: string }) {
  const { network } = useNetwork();
  const symbolSlug = cdpSymbolSlug(symbol);
  const markets = useGQL<CdpMarketsResponse>(
    network.chainId === 42220 ? CDP_MARKETS : null,
    { chainId: network.chainId },
  );
  const collateral = useMemo(
    () =>
      (markets.data?.LiquityCollateral ?? []).find(
        (row) => cdpSymbolSlug(row.symbol) === symbolSlug,
      ),
    [markets.data, symbolSlug],
  );
  const detail = useGQL<CdpDetailResponse>(
    collateral == null ? null : CDP_MARKET_DETAIL,
    collateral == null ? undefined : { collateralId: collateral.id },
  );
  const snapshots = useGQL<CdpDailySnapshotsResponse>(
    collateral == null ? null : CDP_INSTANCE_DAILY_SNAPSHOTS,
    collateral == null ? undefined : { instanceId: collateral.id },
  );

  if (network.chainId !== 42220) {
    return (
      <EmptyBox message="CDP markets are only deployed on Celo mainnet." />
    );
  }
  return (
    <CdpDetailState
      markets={markets}
      detail={detail}
      snapshots={snapshots}
      collateral={collateral}
      network={network}
    />
  );
}

function CdpDetailState({
  markets,
  detail,
  snapshots,
  collateral,
  network,
}: {
  markets: ReturnType<typeof useGQL<CdpMarketsResponse>>;
  detail: ReturnType<typeof useGQL<CdpDetailResponse>>;
  snapshots: ReturnType<typeof useGQL<CdpDailySnapshotsResponse>>;
  collateral: CdpCollateral | undefined;
  network: Network;
}) {
  // aggregateTroves loops over up to 500 trove rows to produce the borrower
  // count; memoize so the 30s SWR refresh doesn't recompute when neither
  // input changed. systemDebt/systemColl come from `LiquityInstance` directly.
  const aggregates = useMemo(
    () =>
      collateral == null
        ? null
        : aggregatesFromChainTroves(collateral.id, markets.data?.Trove),
    [collateral, markets.data?.Trove],
  );

  if (markets.isLoading || (collateral != null && detail.isLoading)) {
    return <Skeleton rows={8} />;
  }
  if (markets.error) {
    return (
      <ErrorBox
        message={`Failed to load CDP markets — ${markets.error.message}`}
      />
    );
  }
  if (collateral == null || aggregates == null) {
    return <EmptyBox message="Unknown CDP market." />;
  }
  if (detail.error) {
    return (
      <ErrorBox
        message={`Failed to load CDP market — ${detail.error.message}`}
      />
    );
  }
  return (
    <CdpDetailContent
      {...buildContentProps({
        detail,
        snapshots,
        collateral,
        network,
        aggregates,
      })}
    />
  );
}

function buildContentProps({
  detail,
  snapshots,
  collateral,
  network,
  aggregates,
}: {
  detail: ReturnType<typeof useGQL<CdpDetailResponse>>;
  snapshots: ReturnType<typeof useGQL<CdpDailySnapshotsResponse>>;
  collateral: CdpCollateral;
  network: Network;
  aggregates: ReturnType<typeof aggregateTroves>;
}) {
  return {
    collateral,
    instance: detail.data?.LiquityInstance[0],
    troves: detail.data?.Trove ?? [],
    depositors: detail.data?.StabilityPoolDepositor ?? [],
    cdpPools: detail.data?.CdpPool ?? [],
    aggregates,
    snapshots: snapshots.data?.LiquityInstanceDailySnapshot ?? [],
    snapshotsLoading: snapshots.isLoading,
    snapshotsError: snapshots.error != null,
    network,
  };
}

// For the borrower count, use the chain-wide markets-list query (up to 500
// troves) filtered to this collateral, NOT the 50-row detail query — that
// one exists only for the recent-activity table and would understate the
// open-trove count for any market with >50 open troves.
function aggregatesFromChainTroves(
  collateralId: string,
  allChainTroves: CdpTroveListRow[] | undefined,
) {
  const rows = allChainTroves ?? [];
  return aggregateTroves(
    rows.filter((t) => t.collateralId === collateralId),
    { truncated: rows.length >= CDP_TROVES_LIST_LIMIT },
  );
}

function CdpDetailContent({
  collateral,
  instance,
  troves,
  depositors,
  cdpPools,
  aggregates,
  snapshots,
  snapshotsLoading,
  snapshotsError,
  network,
}: {
  collateral: CdpCollateral;
  instance: CdpInstance | undefined;
  troves: CdpTrove[];
  depositors: CdpDepositor[];
  cdpPools: CdpPoolRow[];
  aggregates: ReturnType<typeof aggregateTroves>;
  snapshots: CdpInstanceDailySnapshot[];
  snapshotsLoading: boolean;
  snapshotsError: boolean;
  network: Network;
}) {
  return (
    <div className="space-y-8">
      <DetailHeader collateral={collateral} instance={instance} />

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Tile
          label="Total Supply (System Debt)"
          value={formatTokenAmount(instance?.systemDebt, collateral.symbol)}
        />
        <Tile
          label="System Collateral"
          value={formatTokenAmount(instance?.systemColl, "USDm")}
        />
        <Tile
          label="Stability Pool"
          value={formatTokenAmount(instance?.spDeposits, collateral.symbol)}
          href={explorerAddressUrl(network, collateral.stabilityPool)}
        />
        <Tile
          label="Open Troves"
          value={
            instance == null
              ? "—"
              : `${aggregates.truncated ? "≥" : ""}${aggregates.openTroveCount}`
          }
          subtitle={
            aggregates.truncated
              ? "Trove list truncated"
              : `Updated ${relativeTime(instance?.lastEventTimestamp ?? "0")}`
          }
        />
      </section>

      <RedemptionsSection
        instance={instance}
        symbol={collateral.symbol}
      />

      <CdpStabilityPoolTvlChart
        snapshots={snapshots}
        currentSpDeposits={instance?.spDeposits}
        symbol={collateral.symbol}
        isLoading={snapshotsLoading}
        hasError={snapshotsError}
      />

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TroveTable
          troves={troves}
          symbol={collateral.symbol}
          chainId={collateral.chainId}
        />
        <DepositorTable
          depositors={depositors}
          symbol={collateral.symbol}
          chainId={collateral.chainId}
        />
      </section>

      <CdpPoolsTable cdpPools={cdpPools} />

      <CdpTransactionsTable
        instanceId={collateral.id}
        chainId={collateral.chainId}
        symbol={collateral.symbol}
      />
    </div>
  );
}

function DetailHeader({
  collateral,
  instance,
}: {
  collateral: CdpCollateral;
  instance: CdpInstance | undefined;
}) {
  const health = deriveCdpHealth(collateral, instance);
  return (
    <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <Link
          href="/cdps"
          className="text-sm text-indigo-400 hover:text-indigo-300"
        >
          CDPs
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-white">
          {collateral.symbol} CDP Market
        </h1>
      </div>
      <div className="flex flex-col items-end gap-1">
        <CdpHealthBadge health={health} />
        <span className="text-xs text-slate-500">
          Last event {relativeTime(instance?.lastEventTimestamp ?? "0")}
        </span>
      </div>
    </header>
  );
}

/** Total / User / Rebalance redemption KPI tiles. The indexer (post-commit
 * 026c629) tracks the rebalance subset separately via `tx.to ==
 * cdpLiquidityStrategy`; user-driven = total − rebalance. */
function RedemptionsSection({
  instance,
  symbol,
}: {
  instance: CdpInstance | undefined;
  symbol: string;
}) {
  const totalCount = instance?.redemptionCountCum ?? 0;
  const rebalanceCount = instance?.rebalanceRedemptionCountCum ?? 0;
  const userCount = Math.max(0, totalCount - rebalanceCount);
  const totalDebt = instance?.redemptionDebtCum ?? null;
  const rebalanceDebt = instance?.rebalanceRedemptionDebtCum ?? null;
  const userDebt =
    totalDebt != null && rebalanceDebt != null
      ? (BigInt(totalDebt) - BigInt(rebalanceDebt)).toString()
      : null;
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">Redemptions</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Tile
          label="Total Redemptions"
          value={formatTokenAmount(totalDebt, symbol)}
          subtitle={`${totalCount.toLocaleString()} event${totalCount === 1 ? "" : "s"}`}
        />
        <Tile
          label="User Redemptions"
          value={formatTokenAmount(userDebt, symbol)}
          subtitle={`${userCount.toLocaleString()} event${userCount === 1 ? "" : "s"}`}
        />
        <Tile
          label="Rebalance Redemptions"
          value={formatTokenAmount(rebalanceDebt, symbol)}
          subtitle={`${rebalanceCount.toLocaleString()} event${rebalanceCount === 1 ? "" : "s"}`}
        />
      </div>
    </section>
  );
}

function CdpPoolsTable({ cdpPools }: { cdpPools: CdpPoolRow[] }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">CDP Pools</h2>
      {cdpPools.length === 0 ? (
        <EmptyBox message="No active FPMM pools linked to this CDP market." />
      ) : (
        <Table>
          <thead>
            <Row>
              <Th>Pool</Th>
              <Th align="right">Cooldown</Th>
              <Th align="right">Updated</Th>
            </Row>
          </thead>
          <tbody>
            {cdpPools.map((pool) => (
              <Row key={pool.id}>
                <Td mono>
                  <Link
                    href={buildPoolDetailHref(pool.poolId)}
                    className="text-indigo-400 hover:text-indigo-300"
                  >
                    {truncateAddress(pool.poolId)}
                  </Link>
                </Td>
                <Td align="right">{pool.rebalanceCooldownSec}s</Td>
                <Td align="right">{relativeTime(pool.updatedAtTimestamp)}</Td>
              </Row>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

function TroveTable({
  troves,
  symbol,
  chainId,
}: {
  troves: CdpTrove[];
  symbol: string;
  chainId: number;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">
        Recent Live Troves
      </h2>
      {troves.length === 0 ? (
        <EmptyBox message="No troves indexed yet." />
      ) : (
        <Table>
          <thead>
            <Row>
              <Th>Owner</Th>
              <Th>Status</Th>
              <Th align="right">Debt</Th>
              <Th align="right">Updated</Th>
            </Row>
          </thead>
          <tbody>
            {troves.map((trove) => (
              <Row key={trove.id}>
                <Td>
                  <AddressLink address={trove.owner} chainId={chainId} />
                </Td>
                <Td>{trove.status}</Td>
                <Td align="right">{formatTokenAmount(trove.debt, symbol)}</Td>
                <Td align="right">{relativeTime(trove.lastUpdatedAt)}</Td>
              </Row>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

function DepositorTable({
  depositors,
  symbol,
  chainId,
}: {
  depositors: CdpDepositor[];
  symbol: string;
  chainId: number;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">
        Last-Touched Depositors
      </h2>
      {depositors.length === 0 ? (
        <EmptyBox message="No stability pool depositors indexed yet." />
      ) : (
        <Table>
          <thead>
            <Row>
              <Th>Depositor</Th>
              <Th align="right">Deposit</Th>
              <Th align="right">Stashed Coll</Th>
              <Th align="right">Updated</Th>
            </Row>
          </thead>
          <tbody>
            {depositors.map((depositor) => (
              <Row key={depositor.id}>
                <Td>
                  <AddressLink address={depositor.address} chainId={chainId} />
                </Td>
                <Td align="right">
                  {formatTokenAmount(depositor.lastTouchedDeposit, symbol)}
                </Td>
                <Td align="right">
                  {formatWei(depositor.stashedColl, 18, 2)} USDm
                </Td>
                <Td align="right">{relativeTime(depositor.lastUpdatedAt)}</Td>
              </Row>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}
