"use client";

import { useMemo } from "react";
import { useNetwork } from "@/components/network-provider";
import { EmptyBox, ErrorBox, Skeleton } from "@/components/feedback";
import { useGQL } from "@/lib/graphql";
import { ALL_CDP_TRANSACTIONS, CDP_MARKETS } from "@/lib/queries";
import {
  CDP_TROVES_LIST_LIMIT,
  type CdpCollateral,
  type CdpInstance,
  type CdpTroveListRow,
} from "../_lib/types";
import {
  aggregatesForCollateral,
  isOpenTroveStatus,
  type CdpAggregates,
} from "../_lib/health";
import {
  CDP_OVERVIEW_PER_KIND_FETCH_LIMIT,
  type CdpTransactionsResponse,
  mergeTransactionRows,
} from "../_lib/transactions";
import { CdpAllTransactionsTable } from "./cdp-all-transactions-table";
import { CdpMarketCard } from "./cdp-market-card";

const ONE_DAY_SECONDS = 86_400;

type CdpMarketsResponse = {
  LiquityCollateral: CdpCollateral[];
  LiquityInstance: CdpInstance[];
  Trove: CdpTroveListRow[];
};

/** Returns true when this per-kind array hit the fetch cap AND its
 *  oldest row is still inside the 24h cutoff — i.e. the cap could
 *  have chopped off additional rows within the same window. Each
 *  kind's array is `timestamp DESC LIMIT N`, so `rows.at(-1)` is the
 *  oldest fetched row of that kind. Truncation is per-kind (each event
 *  type runs its own LIMIT query), so we have to check each kind
 *  independently — using the merged tail row would miss cases where
 *  one kind's 30-day-old trove ops dominate the merged oldest position
 *  while a different kind's capped 24h-spanning slice is silently
 *  undercounting. */
function isKindAtCapInWindow(
  rows: { timestamp: string }[] | undefined,
  cutoff: number,
): boolean {
  if (rows == null || rows.length < CDP_OVERVIEW_PER_KIND_FETCH_LIMIT) {
    return false;
  }
  const oldest = rows[rows.length - 1];
  return oldest != null && Number(oldest.timestamp) >= cutoff;
}

/** Per-market 24h ops count + cap flag, derived from the chain-scoped
 *  overview transactions fetch. Shares the SWR cache with the table
 *  mounted below so we don't double-fetch. */
function useOps24hByInstance(chainId: number) {
  const transactions = useGQL<CdpTransactionsResponse>(
    chainId === 42220 ? ALL_CDP_TRANSACTIONS : null,
    { chainId, limit: CDP_OVERVIEW_PER_KIND_FETCH_LIMIT },
  );
  const txData = transactions.data;
  const isLoading = transactions.isLoading;
  const hasError = transactions.error != null;
  return useMemo(() => {
    const merged = mergeTransactionRows(
      txData,
      CDP_OVERVIEW_PER_KIND_FETCH_LIMIT,
    );
    const cutoff = Math.floor(Date.now() / 1000) - ONE_DAY_SECONDS;
    const counts = new Map<string, number>();
    for (const row of merged.rows) {
      if (!row.instanceId) continue;
      if (Number(row.timestamp) < cutoff) continue;
      counts.set(row.instanceId, (counts.get(row.instanceId) ?? 0) + 1);
    }
    const undercountPossible = [
      txData?.LiquidationEvent,
      txData?.RedemptionEvent,
      txData?.SpRebalanceEvent,
      txData?.TroveOperationEvent,
    ].some((rows) => isKindAtCapInWindow(rows, cutoff));
    return {
      ops24hByInstance: counts,
      txCapped: undercountPossible,
      isLoading,
      hasError,
    };
  }, [txData, isLoading, hasError]);
}

export function CdpsPageClient() {
  const { network } = useNetwork();
  const { data, error, isLoading } = useGQL<CdpMarketsResponse>(
    network.chainId === 42220 ? CDP_MARKETS : null,
    { chainId: network.chainId },
  );
  const {
    ops24hByInstance,
    txCapped,
    isLoading: txLoading,
    hasError: txHasError,
  } = useOps24hByInstance(network.chainId);

  const liquityInstances = data?.LiquityInstance;
  const troves = data?.Trove;

  const instances = useMemo(() => {
    const m = new Map<string, CdpInstance>();
    for (const instance of liquityInstances ?? []) {
      m.set(instance.collateralId, instance);
    }
    return m;
  }, [liquityInstances]);

  // Chain-wide cap → if hit, EVERY collateral's aggregate is suspect
  // because the `order_by lastUpdatedAt desc` slice can push an entire
  // collateral's troves off-page; the per-collateral fallback below also
  // carries this flag so a missing-entry collateral isn't shown as Healthy.
  const queryTruncated = (troves?.length ?? 0) >= CDP_TROVES_LIST_LIMIT;

  const aggregatesByCollateral = useMemo(() => {
    // Single pass: accumulate directly per collateralId, skipping non-open
    // statuses inline. Avoids the intermediate `grouped` map of trove arrays.
    const out = new Map<string, CdpAggregates>();
    for (const trove of troves ?? []) {
      if (!isOpenTroveStatus(trove.status)) continue;
      const agg = out.get(trove.collateralId) ?? {
        openTroveCount: 0,
        totalDebt: BigInt(0),
        totalColl: BigInt(0),
        truncated: queryTruncated,
      };
      out.set(trove.collateralId, {
        ...agg,
        openTroveCount: agg.openTroveCount + 1,
        totalDebt: agg.totalDebt + BigInt(trove.debt),
        totalColl: agg.totalColl + BigInt(trove.coll),
      });
    }
    return out;
  }, [troves, queryTruncated]);

  if (network.chainId !== 42220) {
    return (
      <EmptyBox message="CDP markets are only deployed on Celo mainnet." />
    );
  }

  if (isLoading) return <Skeleton rows={6} />;
  if (error) {
    return (
      <ErrorBox message={`Failed to load CDP markets — ${error.message}`} />
    );
  }

  const collaterals = data?.LiquityCollateral ?? [];
  if (collaterals.length === 0) {
    return <EmptyBox message="No CDP markets indexed yet." />;
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">CDPs</h1>
        <p className="mt-1 text-sm text-slate-400">
          USDm-backed borrower markets for Mento stable assets.
        </p>
      </header>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {collaterals.map((collateral) => (
          <CdpMarketCard
            key={collateral.id}
            collateral={collateral}
            instance={instances.get(collateral.id)}
            aggregates={aggregatesForCollateral(
              collateral.id,
              aggregatesByCollateral,
              queryTruncated,
            )}
            ops24h={ops24hByInstance.get(collateral.id) ?? 0}
            ops24hCapped={txCapped}
            ops24hLoading={txLoading}
            ops24hHasError={txHasError}
          />
        ))}
      </div>
      <CdpAllTransactionsTable
        collaterals={collaterals}
        chainId={network.chainId}
      />
    </div>
  );
}
