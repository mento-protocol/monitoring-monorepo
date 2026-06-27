"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";
import { AddressLink } from "@/components/address-link";
import { useNetwork } from "@/components/network-provider";
import { EmptyBox, ErrorBox, Skeleton, Tile } from "@/components/feedback";
import { Table, Row, Th, Td } from "@/components/table";
import { useGQL } from "@/lib/graphql";
import {
  CDP_INSTANCE_DAILY_SNAPSHOTS,
  CDP_MARKET_DETAIL,
  CDP_MARKET_DETAIL_WITH_SP_SOURCE,
  CDP_MARKET_DETAIL_WITH_TROVE_TX,
  CDP_MARKET_DETAIL_WITH_TROVE_TX_AND_SP_SOURCE,
  CDP_MARKETS,
  CDP_TROVE_SCHEMA_FIELDS,
} from "@/lib/queries";
import { relativeTime } from "@/lib/format";
import type { Network } from "@/lib/networks";
import { explorerAddressUrl } from "@/lib/tokens";
import {
  CDP_STABILITY_POOL_DEPOSITORS_DETAIL_LIMIT,
  CDP_TROVES_DETAIL_LIMIT,
  type CdpCollateral,
  type CdpDepositor,
  type CdpInterestBatch,
  type CdpInstance,
  type CdpInstanceDailySnapshot,
  type CdpTrove,
  type CdpTroveListRow,
} from "../../_lib/types";
import {
  cdpSymbolSlug,
  formatSignedWei,
  formatTokenAmount,
  redemptionEventSubtitle,
} from "../../_lib/format";
import { aggregateTroves, deriveCdpHealth } from "../../_lib/health";
import { CdpHealthBadge } from "../../_components/cdp-health-badge";
import { CdpStabilityPoolTvlChart } from "./cdp-stability-pool-tvl-chart";
import { CdpTroveTable } from "./cdp-trove-table";
import { CdpTransactionsTable } from "./cdp-transactions-table";

type CdpMarketsResponse = {
  LiquityCollateral: CdpCollateral[];
  LiquityInstance: CdpInstance[];
  Trove: CdpTroveListRow[];
};

type CdpDetailResponse = {
  LiquityCollateral: CdpCollateral[];
  LiquityInstance: CdpInstance[];
  OpenTrove: CdpTrove[];
  AllTrove: CdpTrove[];
  InterestBatch: CdpInterestBatch[];
  StabilityPoolDepositor: CdpDepositor[];
};

type CdpTroveSchemaFieldsResponse = {
  TroveType: {
    fields: Array<{ name: string }>;
  } | null;
  StabilityPoolDepositorType: {
    fields: Array<{ name: string }>;
  } | null;
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
  const troveSchema = useGQL<CdpTroveSchemaFieldsResponse>(
    network.chainId === 42220 ? CDP_TROVE_SCHEMA_FIELDS : null,
    undefined,
    { refreshInterval: 300_000 },
  );
  const supportsTroveLastUpdatedTxHash = useMemo(
    () =>
      troveSchema.data?.TroveType?.fields.some(
        (field) => field.name === "lastUpdatedTxHash",
      ) === true,
    [troveSchema.data],
  );
  const supportsStabilityPoolSourceSplit = useMemo(() => {
    const fields = troveSchema.data?.StabilityPoolDepositorType?.fields;
    return (
      fields?.some((field) => field.name === "cumulativeRebalanceUsed") ===
        true &&
      fields.some((field) => field.name === "cumulativeLiquidationUsed") ===
        true
    );
  }, [troveSchema.data]);
  const detailQuery =
    collateral == null
      ? null
      : supportsTroveLastUpdatedTxHash
        ? supportsStabilityPoolSourceSplit
          ? CDP_MARKET_DETAIL_WITH_TROVE_TX_AND_SP_SOURCE
          : CDP_MARKET_DETAIL_WITH_TROVE_TX
        : supportsStabilityPoolSourceSplit
          ? CDP_MARKET_DETAIL_WITH_SP_SOURCE
          : CDP_MARKET_DETAIL;
  const rawDetail = useGQL<CdpDetailResponse>(
    detailQuery,
    collateral == null ? undefined : { collateralId: collateral.id },
  );
  const detail = useStableCdpDetail(rawDetail, collateral?.id);
  const sourceSplitWarning = sourceSplitLoadWarning({
    supportsStabilityPoolSourceSplit,
    rawDetail,
    detail,
  });
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
      sourceSplitWarning={sourceSplitWarning}
    />
  );
}

function sourceSplitLoadWarning({
  supportsStabilityPoolSourceSplit,
  rawDetail,
  detail,
}: {
  supportsStabilityPoolSourceSplit: boolean;
  rawDetail: ReturnType<typeof useGQL<CdpDetailResponse>>;
  detail: ReturnType<typeof useGQL<CdpDetailResponse>>;
}): string | null {
  if (!supportsStabilityPoolSourceSplit) return null;
  if (rawDetail.error == null || rawDetail.data != null) return null;
  if (detail.data == null) return null;
  return `Rebalance/liquidation split unavailable — ${rawDetail.error.message}`;
}

function useStableCdpDetail(
  detail: ReturnType<typeof useGQL<CdpDetailResponse>>,
  collateralId: string | undefined,
): ReturnType<typeof useGQL<CdpDetailResponse>> {
  const previous = useRef<{
    collateralId: string;
    data: CdpDetailResponse;
  } | null>(null);

  useEffect(() => {
    if (collateralId == null || detail.data == null) return;
    previous.current = { collateralId, data: detail.data };
  }, [collateralId, detail.data]);

  if (detail.data != null || collateralId == null) return detail;
  if (previous.current?.collateralId !== collateralId) return detail;

  return {
    ...detail,
    data: previous.current.data,
    error: undefined,
    isLoading: false,
  };
}

function CdpDetailState({
  markets,
  detail,
  snapshots,
  collateral,
  network,
  sourceSplitWarning,
}: {
  markets: ReturnType<typeof useGQL<CdpMarketsResponse>>;
  detail: ReturnType<typeof useGQL<CdpDetailResponse>>;
  snapshots: ReturnType<typeof useGQL<CdpDailySnapshotsResponse>>;
  collateral: CdpCollateral | undefined;
  network: Network;
  sourceSplitWarning: string | null;
}) {
  if (
    markets.isLoading ||
    (collateral != null && detail.isLoading && detail.data == null)
  ) {
    return <Skeleton rows={8} />;
  }
  if (markets.error) {
    return (
      <ErrorBox
        message={`Failed to load CDP markets — ${markets.error.message}`}
      />
    );
  }
  if (collateral == null) {
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
        sourceSplitWarning,
      })}
    />
  );
}

function buildContentProps({
  detail,
  snapshots,
  collateral,
  network,
  sourceSplitWarning,
}: {
  detail: ReturnType<typeof useGQL<CdpDetailResponse>>;
  snapshots: ReturnType<typeof useGQL<CdpDailySnapshotsResponse>>;
  collateral: CdpCollateral;
  network: Network;
  sourceSplitWarning: string | null;
}) {
  const openTroves = detail.data?.OpenTrove ?? [];
  const depositors = detail.data?.StabilityPoolDepositor ?? [];
  return {
    collateral,
    instance: detail.data?.LiquityInstance[0],
    openTroves,
    allTroves: detail.data?.AllTrove ?? [],
    interestBatches: detail.data?.InterestBatch ?? [],
    depositors,
    depositorsTruncated:
      depositors.length >= CDP_STABILITY_POOL_DEPOSITORS_DETAIL_LIMIT,
    aggregates: aggregateTroves(openTroves, {
      truncated: openTroves.length >= CDP_TROVES_DETAIL_LIMIT,
    }),
    snapshots: snapshots.data?.LiquityInstanceDailySnapshot ?? [],
    snapshotsLoading: snapshots.isLoading,
    snapshotsError: snapshots.error != null,
    network,
    sourceSplitWarning,
  };
}

function CdpDetailContent({
  collateral,
  instance,
  openTroves,
  allTroves,
  interestBatches,
  depositors,
  depositorsTruncated,
  aggregates,
  snapshots,
  snapshotsLoading,
  snapshotsError,
  network,
  sourceSplitWarning,
}: {
  collateral: CdpCollateral;
  instance: CdpInstance | undefined;
  openTroves: CdpTrove[];
  allTroves: CdpTrove[];
  interestBatches: CdpInterestBatch[];
  depositors: CdpDepositor[];
  depositorsTruncated: boolean;
  aggregates: ReturnType<typeof aggregateTroves>;
  snapshots: CdpInstanceDailySnapshot[];
  snapshotsLoading: boolean;
  snapshotsError: boolean;
  network: Network;
  sourceSplitWarning: string | null;
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

      <RedemptionsSection instance={instance} symbol={collateral.symbol} />

      <CdpStabilityPoolTvlChart
        snapshots={snapshots}
        currentSpDeposits={instance?.spDeposits}
        minBoldAfterRebalance={collateral.minBoldAfterRebalance}
        symbol={collateral.symbol}
        isLoading={snapshotsLoading}
        hasError={snapshotsError}
      />

      <CdpTroveTable
        openTroves={openTroves}
        allTroves={allTroves}
        interestBatches={interestBatches}
        collateral={collateral}
      />

      <DepositorTable
        depositors={depositors}
        truncated={depositorsTruncated}
        symbol={collateral.symbol}
        chainId={collateral.chainId}
        sourceSplitWarning={sourceSplitWarning}
      />

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
  // When `instance` is undefined (no LiquityInstance row indexed yet for this
  // collateral, or a transient query gap), every tile renders `—` for both
  // amount and event-count — never a happy-path "0 events".
  const totalCount = instance?.redemptionCountCum;
  const rebalanceCount = instance?.rebalanceRedemptionCountCum;
  const userCount =
    totalCount != null && rebalanceCount != null
      ? Math.max(0, totalCount - rebalanceCount)
      : null;
  const totalDebt = instance?.redemptionDebtCum ?? null;
  const rebalanceDebt = instance?.rebalanceRedemptionDebtCum ?? null;
  // Clamp the subtraction to 0 to mirror `userCount`'s Math.max(0, ...) —
  // defensive consistency. The indexer writes both counters in a single
  // LiquityInstance.set call so rebalance > total isn't a live race today.
  let userDebt: string | null = null;
  if (totalDebt != null && rebalanceDebt != null) {
    const diff = BigInt(totalDebt) - BigInt(rebalanceDebt);
    userDebt = diff < BigInt(0) ? "0" : diff.toString();
  }
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">Redemptions</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Tile
          label="Total Redemptions"
          value={formatTokenAmount(totalDebt, symbol)}
          subtitle={redemptionEventSubtitle(totalCount)}
        />
        <Tile
          label="User Redemptions"
          value={formatTokenAmount(userDebt, symbol)}
          subtitle={redemptionEventSubtitle(userCount)}
        />
        <Tile
          label="Rebalance Redemptions"
          value={formatTokenAmount(rebalanceDebt, symbol)}
          subtitle={redemptionEventSubtitle(rebalanceCount)}
        />
      </div>
    </section>
  );
}

function DepositorTable({
  depositors,
  truncated,
  symbol,
  chainId,
  sourceSplitWarning,
}: {
  depositors: CdpDepositor[];
  truncated: boolean;
  symbol: string;
  chainId: number;
  sourceSplitWarning: string | null;
}) {
  const hasSourceSplitData = depositors.some(
    (depositor) =>
      depositor.cumulativeRebalanceUsed !== undefined &&
      depositor.cumulativeLiquidationUsed !== undefined,
  );

  return (
    <section>
      <DepositorTableIntro
        truncated={truncated}
        sourceSplitWarning={sourceSplitWarning}
      />
      {depositors.length === 0 ? (
        <EmptyBox message="No stability pool LPs indexed yet." />
      ) : (
        <Table>
          <thead>
            <Row>
              <Th>LP</Th>
              <Th align="right">Current Deposit Snapshot</Th>
              <Th align="right">Gross Deposited (+)</Th>
              <Th align="right">Principal Withdrawn (-)</Th>
              {hasSourceSplitData && <Th align="right">Rebalance Used (-)</Th>}
              {hasSourceSplitData && (
                <Th align="right">Liquidation Used (-)</Th>
              )}
              <Th align="right">Unclaimed Collateral</Th>
              <Th align="right">Snapshot Updated</Th>
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
                  {formatTokenAmount(depositor.cumulativeDeposited, symbol)}
                </Td>
                <Td align="right">
                  {formatTokenAmount(depositor.cumulativeWithdrawn, symbol)}
                </Td>
                {hasSourceSplitData && (
                  <Td align="right">
                    {depositor.cumulativeRebalanceUsed === undefined
                      ? "Not indexed"
                      : formatSignedWei(
                          depositor.cumulativeRebalanceUsed,
                          symbol,
                        )}
                  </Td>
                )}
                {hasSourceSplitData && (
                  <Td align="right">
                    {depositor.cumulativeLiquidationUsed === undefined
                      ? "Not indexed"
                      : formatSignedWei(
                          depositor.cumulativeLiquidationUsed,
                          symbol,
                        )}
                  </Td>
                )}
                <Td align="right">
                  {formatTokenAmount(depositor.stashedColl, "USDm")}
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

function DepositorTableIntro({
  truncated,
  sourceSplitWarning,
}: {
  truncated: boolean;
  sourceSplitWarning: string | null;
}) {
  return (
    <>
      <h2 className="text-lg font-semibold text-white mb-3">
        Stability Pool LP Snapshots
      </h2>
      <p className="mb-3 text-xs text-slate-500">
        Debt-token flow per row: current deposit snapshot equals gross deposited
        minus principal withdrawn minus debt-token deposit used by CDP
        rebalances and Liquity liquidations, net of retained debt-token yield.
        Redemptions do not consume Stability Pool deposits. Unclaimed collateral
        is the separate USDm gain currently indexed for the LP.
      </p>
      {sourceSplitWarning != null && (
        <p className="mb-3 text-xs text-amber-400" role="status">
          {sourceSplitWarning}
        </p>
      )}
      {truncated && (
        <p className="mb-3 text-xs text-amber-400" role="status">
          Showing the first{" "}
          {CDP_STABILITY_POOL_DEPOSITORS_DETAIL_LIMIT.toLocaleString()} LP
          snapshots by indexed deposit. More snapshots may exist.
        </p>
      )}
    </>
  );
}
