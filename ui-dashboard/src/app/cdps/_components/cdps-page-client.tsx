"use client";

import { useMemo } from "react";
import { useNetwork } from "@/components/network-provider";
import { EmptyBox, ErrorBox, Skeleton } from "@/components/feedback";
import { useGQL } from "@/lib/graphql";
import { hasErrorWithoutData, isLoadingWithoutData } from "@/lib/swr-state";
import {
  ALL_CDP_STABILITY_POOL_EVENTS,
  ALL_CDP_TRANSACTIONS,
  CDP_MARKETS,
} from "@/lib/queries";
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
  type CdpActivitySummary,
  type CdpMarketActivity,
  EMPTY_CDP_MARKET_ACTIVITY,
  type CdpStabilityPoolEventsResponse,
  type CdpTransactionsResponse,
  mergeTransactionRows,
  summarizeCdpActivity,
} from "../_lib/transactions";
import { CdpActivityDigest } from "./cdp-activity-digest";
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
function useActivity24hByInstance(chainId: number): {
  activityByInstance: Map<string, CdpMarketActivity>;
  totalActivity: CdpActivitySummary;
  txCapped: boolean;
  isLoading: boolean;
  hasError: boolean;
} {
  const transactions = useGQL<CdpTransactionsResponse>(
    chainId === 42220 ? ALL_CDP_TRANSACTIONS : null,
    { chainId, limit: CDP_OVERVIEW_PER_KIND_FETCH_LIMIT },
  );
  const stabilityPoolEvents = useGQL<CdpStabilityPoolEventsResponse>(
    chainId === 42220 ? ALL_CDP_STABILITY_POOL_EVENTS : null,
    { chainId, limit: CDP_OVERVIEW_PER_KIND_FETCH_LIMIT },
  );
  const txData = transactions.data;
  const spData = stabilityPoolEvents.data;
  const isLoading =
    isLoadingWithoutData(transactions.isLoading, txData) ||
    isLoadingWithoutData(stabilityPoolEvents.isLoading, spData);
  const hasError = hasErrorWithoutData(transactions.error, txData);
  const spEventsUnavailable = hasErrorWithoutData(
    stabilityPoolEvents.error,
    spData,
  );
  return useMemo(() => {
    const merged = mergeTransactionRows(
      txData,
      CDP_OVERVIEW_PER_KIND_FETCH_LIMIT,
      spData,
    );
    const cutoff = Math.floor(Date.now() / 1000) - ONE_DAY_SECONDS;
    const totalActivity = summarizeCdpActivity(merged.rows);
    const undercountPossible =
      spEventsUnavailable ||
      [
        txData?.LiquidationEvent,
        txData?.RedemptionEvent,
        txData?.SpRebalanceEvent,
        spData?.StabilityPoolOperationEvent,
        txData?.TroveOperationEvent,
      ].some((rows) => isKindAtCapInWindow(rows, cutoff));
    return {
      activityByInstance: totalActivity.byInstance,
      totalActivity,
      txCapped: undercountPossible,
      isLoading,
      hasError,
    };
  }, [txData, spData, isLoading, hasError, spEventsUnavailable]);
}

export function CdpsPageClient() {
  const { network } = useNetwork();
  const { data, error, isLoading } = useGQL<CdpMarketsResponse>(
    network.chainId === 42220 ? CDP_MARKETS : null,
    { chainId: network.chainId },
  );
  const {
    activityByInstance,
    totalActivity,
    txCapped,
    isLoading: txLoading,
    hasError: txHasError,
  } = useActivity24hByInstance(network.chainId);

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
    // Single pass: count opens per collateralId, skipping non-open
    // statuses inline. Borrower count only — system debt/coll come from
    // `LiquityInstance` directly so we no longer accumulate per-row sums.
    const out = new Map<string, CdpAggregates>();
    for (const trove of troves ?? []) {
      if (!isOpenTroveStatus(trove.status)) continue;
      const agg = out.get(trove.collateralId) ?? {
        openTroveCount: 0,
        truncated: queryTruncated,
      };
      out.set(trove.collateralId, {
        ...agg,
        openTroveCount: agg.openTroveCount + 1,
      });
    }
    return out;
  }, [troves, queryTruncated]);

  if (network.chainId !== 42220) {
    return (
      <EmptyBox message="CDP markets are only deployed on Celo mainnet." />
    );
  }

  if (isLoadingWithoutData(isLoading, data)) return <Skeleton rows={6} />;
  if (hasErrorWithoutData(error, data)) {
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
            activity24h={
              activityByInstance.get(collateral.id) ?? EMPTY_CDP_MARKET_ACTIVITY
            }
            ops24hCapped={txCapped}
            ops24hLoading={txLoading}
            ops24hHasError={txHasError}
          />
        ))}
      </div>
      <CdpActivityDigest
        collaterals={collaterals}
        instances={instances}
        aggregatesByCollateral={aggregatesByCollateral}
        queryTruncated={queryTruncated}
        activityByInstance={activityByInstance}
        totalActivity={totalActivity}
        activityCapped={txCapped}
        activityLoading={txLoading}
        activityHasError={txHasError}
      />
      <CdpAllTransactionsTable
        collaterals={collaterals}
        chainId={network.chainId}
      />
    </div>
  );
}
