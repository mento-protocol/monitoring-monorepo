"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useNetwork } from "@/components/network-provider";
import { EmptyBox, ErrorBox, StaleRefreshNotice } from "@/components/feedback";
import { HASURA_TIMEOUT_MS, useGQL } from "@/lib/graphql";
import { hasErrorWithoutData, isLoadingWithoutData } from "@/lib/swr-state";
import type { Network } from "@/lib/networks";
import { explorerAddressUrl } from "@/lib/tokens";
import {
  CDP_INTEREST_BATCH_BY_ID,
  CDP_MARKETS,
  CDP_TROVE_BY_ID,
  CDP_TROVE_BY_ID_WITHOUT_TX,
  CDP_TROVE_OPERATIONS,
  CDP_TROVE_SCHEMA_FIELDS,
} from "@/lib/queries";
import {
  CDP_TROVE_OPEN_STATUSES,
  type CdpCollateral,
  type CdpInterestBatch,
  type CdpTrove,
  type CdpTroveListRow,
  type CdpTroveOperationEventRow,
} from "../../../../_lib/types";
import { cdpSymbolSlug } from "../../../../_lib/format";
import {
  CDP_TROVE_OPERATIONS_REQUEST_LIMIT,
  makeTroveEntityId,
  paginateTroveOperations,
} from "../_lib/params";
import { TroveDetailSkeleton } from "./trove-detail-skeleton";
import { TroveHeaderCard } from "./trove-header-card";
import { TroveLifetimeTotals } from "./trove-lifetime-totals";
import { TroveOperationsList } from "./trove-operations-list";

const CELO_MAINNET_CHAIN_ID = 42220;

type CdpMarketsResponse = {
  LiquityCollateral: CdpCollateral[];
  LiquityInstance: unknown[];
  Trove: CdpTroveListRow[];
};

type CdpTroveByIdResponse = {
  Trove: CdpTrove[];
};

type CdpTroveSchemaFieldsResponse = {
  TroveType: {
    fields: Array<{ name: string }>;
  } | null;
};

type CdpInterestBatchByIdResponse = {
  InterestBatch: CdpInterestBatch[];
};

type CdpTroveOperationsResponse = {
  TroveOperationEvent: CdpTroveOperationEventRow[];
};

function isOpenTroveStatus(status: string): boolean {
  return (CDP_TROVE_OPEN_STATUSES as readonly string[]).includes(status);
}

/** Schema-lag fallback (same pattern as the market page's
 *  `cdp-detail-client.tsx`): picks the `Trove` query variant that matches
 *  what the schema probe actually found support for. */
function resolveTroveByIdQuery(
  troveEntityId: string | null,
  supportsTroveLastUpdatedTxHash: boolean,
): string | null {
  if (troveEntityId == null) return null;
  return supportsTroveLastUpdatedTxHash
    ? CDP_TROVE_BY_ID
    : CDP_TROVE_BY_ID_WITHOUT_TX;
}

/** Batch-rate join target (mirrors `buildRankedOpenRows` in the market
 *  page's `trove-row-data.ts`): only for a currently-open trove, since a
 *  closed/liquidated/redeemed trove's rate is a historical snapshot, not a
 *  live obligation — joining a closed trove to the batch's CURRENT rate
 *  would misrepresent what it actually paid. */
function resolveJoinBatchId(trove: CdpTrove | undefined): string | null {
  if (trove?.interestBatchId == null) return null;
  return isOpenTroveStatus(trove.status) ? trove.interestBatchId : null;
}

/** The rate to render in the header. When a batch join applies
 *  (`joinBatchId` set), `trove.interestRate` is a snapshot the batch
 *  manager may have already superseded — NEVER show it as a placeholder
 *  while the join is loading, failed, or came back empty; render `null`
 *  (an explicit "unavailable" dash) instead so the header never presents a
 *  possibly-stale copied rate as the confirmed current one. Only a
 *  successfully-resolved join, or no join applying at all (not
 *  batch-managed, or a closed trove's historical snapshot), yields a rate. */
function resolveDisplayedInterestRate(
  trove: CdpTrove | undefined,
  joinBatchId: string | null,
  resolvedBatchRate: string | null | undefined,
): string | null {
  if (trove == null) return null;
  if (joinBatchId == null) return trove.interestRate;
  return resolvedBatchRate ?? null;
}

/** Only disclose a batch-rate refresh failure once a rate was actually
 *  confirmed and is still on screen (mirrors the markets/trove notices,
 *  which are only reachable past `hasErrorWithoutData`, i.e. with data
 *  present). A first-attempt failure with nothing confirmed yet already
 *  reads honestly as "—" via {@link resolveDisplayedInterestRate} — a
 *  "last confirmed state" notice would misstate that as stale data. */
function resolveInterestBatchNoticeError(
  resolvedBatchRate: string | null | undefined,
  error: Error | undefined,
): Error | undefined {
  return resolvedBatchRate != null ? error : undefined;
}

export function TroveDetailClient({
  symbol,
  troveId,
}: {
  symbol: string;
  /** Already validated + lowercased by the server component (page.tsx). */
  troveId: string;
}) {
  const { network } = useNetwork();
  const symbolSlug = cdpSymbolSlug(symbol);
  const markets = useGQL<CdpMarketsResponse>(
    network.chainId === CELO_MAINNET_CHAIN_ID ? CDP_MARKETS : null,
    { chainId: network.chainId },
    { timeoutMs: HASURA_TIMEOUT_MS },
  );
  const collateral = useMemo(
    () =>
      (markets.data?.LiquityCollateral ?? []).find(
        (row) => cdpSymbolSlug(row.symbol) === symbolSlug,
      ),
    [markets.data, symbolSlug],
  );
  // Schema-lag probe (same query + pattern as the market page's
  // `cdp-detail-client.tsx`): `lastUpdatedTxHash` is a newer `Trove` column,
  // so a hosted Hasura instance mid deploy+resync would reject the whole
  // header query for an unknown field if we queried it unconditionally.
  const troveSchema = useGQL<CdpTroveSchemaFieldsResponse>(
    network.chainId === CELO_MAINNET_CHAIN_ID ? CDP_TROVE_SCHEMA_FIELDS : null,
    undefined,
    { refreshInterval: 300_000, timeoutMs: HASURA_TIMEOUT_MS },
  );
  const supportsTroveLastUpdatedTxHash =
    troveSchema.data?.TroveType?.fields.some(
      (field) => field.name === "lastUpdatedTxHash",
    ) === true;
  const troveEntityId =
    collateral == null ? null : makeTroveEntityId(collateral.id, troveId);
  const troveById = useGQL<CdpTroveByIdResponse>(
    resolveTroveByIdQuery(troveEntityId, supportsTroveLastUpdatedTxHash),
    troveEntityId == null ? undefined : { troveEntityId },
    { timeoutMs: HASURA_TIMEOUT_MS },
  );
  const trove = troveById.data?.Trove[0];
  const joinBatchId = resolveJoinBatchId(trove);
  const interestBatch = useGQL<CdpInterestBatchByIdResponse>(
    joinBatchId == null ? null : CDP_INTEREST_BATCH_BY_ID,
    joinBatchId == null ? undefined : { batchId: joinBatchId },
    { timeoutMs: HASURA_TIMEOUT_MS },
  );
  const operations = useGQL<CdpTroveOperationsResponse>(
    collateral == null ? null : CDP_TROVE_OPERATIONS,
    collateral == null
      ? undefined
      : {
          instanceId: collateral.id,
          troveId,
          limit: CDP_TROVE_OPERATIONS_REQUEST_LIMIT,
        },
    { timeoutMs: HASURA_TIMEOUT_MS },
  );
  const { rows: operationRows, truncated } = useMemo(
    () => paginateTroveOperations(operations.data?.TroveOperationEvent ?? []),
    [operations.data],
  );

  if (network.chainId !== CELO_MAINNET_CHAIN_ID) {
    return (
      <EmptyBox message="CDP markets are only deployed on Celo mainnet." />
    );
  }
  const resolvedBatchRate =
    interestBatch.data?.InterestBatch[0]?.annualInterestRate;
  return (
    <TroveDetailView
      symbol={symbol}
      troveId={troveId}
      network={network}
      markets={markets}
      collateral={collateral}
      troveById={troveById}
      trove={trove}
      displayedInterestRate={resolveDisplayedInterestRate(
        trove,
        joinBatchId,
        resolvedBatchRate,
      )}
      interestBatchError={resolveInterestBatchNoticeError(
        resolvedBatchRate,
        interestBatch.error,
      )}
      operations={operations}
      operationRows={operationRows}
      truncated={truncated}
    />
  );
}

/** All post-network-guard rendering (loading/error/not-indexed/content) —
 *  split out of {@link TroveDetailClient} to stay under the file's
 *  max-lines/complexity lint budget; mirrors `CdpDetailState` in the market
 *  page's `cdp-detail-client.tsx`. Takes already-fetched hook results as
 *  props rather than fetching itself. */
function TroveDetailView({
  symbol,
  troveId,
  network,
  markets,
  collateral,
  troveById,
  trove,
  displayedInterestRate,
  interestBatchError,
  operations,
  operationRows,
  truncated,
}: {
  symbol: string;
  troveId: string;
  network: Network;
  markets: ReturnType<typeof useGQL<CdpMarketsResponse>>;
  collateral: CdpCollateral | undefined;
  troveById: ReturnType<typeof useGQL<CdpTroveByIdResponse>>;
  trove: CdpTrove | undefined;
  displayedInterestRate: string | null;
  interestBatchError: Error | undefined;
  operations: ReturnType<typeof useGQL<CdpTroveOperationsResponse>>;
  operationRows: CdpTroveOperationEventRow[];
  truncated: boolean;
}) {
  if (isLoadingWithoutData(markets.isLoading, markets.data)) {
    return <TroveDetailSkeleton />;
  }
  if (hasErrorWithoutData(markets.error, markets.data)) {
    return (
      <ErrorBox
        message={`Failed to load CDP markets — ${markets.error.message}`}
      />
    );
  }
  if (collateral == null) {
    return <EmptyBox message="Unknown CDP market." />;
  }
  if (isLoadingWithoutData(troveById.isLoading, troveById.data)) {
    return <TroveDetailSkeleton />;
  }
  if (hasErrorWithoutData(troveById.error, troveById.data)) {
    return (
      <ErrorBox message={`Failed to load trove — ${troveById.error.message}`} />
    );
  }
  if (trove == null) {
    return (
      <NotIndexedNotice
        troveId={troveId}
        collateral={collateral}
        symbol={symbol}
        network={network}
      />
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/cdps/${symbol}`}
        className="text-sm text-indigo-400 hover:text-indigo-300"
      >
        ← {collateral.symbol} market
      </Link>
      {/* A revalidation failure after either query has already succeeded once
          leaves `data` populated (`hasErrorWithoutData` above is false), so
          the header below keeps rendering — this discloses that it's the
          last confirmed state rather than a silently-stalled poll. */}
      <StaleRefreshNotice
        subject="Market data"
        error={markets.error}
        className="mb-3"
      />
      <StaleRefreshNotice
        subject="Trove data"
        error={troveById.error}
        className="mb-3"
      />
      <StaleRefreshNotice
        subject="Batch rate"
        error={interestBatchError}
        className="mb-3"
      />
      <TroveHeaderCard
        trove={trove}
        collateral={collateral}
        displayedInterestRate={displayedInterestRate}
      />
      <TroveLifetimeTotals trove={trove} debtSymbol={collateral.symbol} />
      <TroveOperationsList
        rows={operationRows}
        truncated={truncated}
        isLoading={operations.isLoading}
        error={operations.error}
        chainId={collateral.chainId}
        debtSymbol={collateral.symbol}
      />
    </div>
  );
}

function NotIndexedNotice({
  troveId,
  collateral,
  symbol,
  network,
}: {
  troveId: string;
  collateral: CdpCollateral;
  symbol: string;
  network: Network;
}) {
  return (
    <div className="space-y-3">
      <EmptyBox
        message={`Trove ${troveId} is not indexed for ${collateral.symbol}. Verify the id, or it may not exist on this market.`}
      />
      <div className="flex gap-3 text-sm">
        <a
          href={explorerAddressUrl(network, collateral.troveManager)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-indigo-400 hover:text-indigo-300"
        >
          View the TroveManager contract ↗
        </a>
        <Link
          href={`/cdps/${symbol}`}
          className="text-indigo-400 hover:text-indigo-300"
        >
          Back to {collateral.symbol} market
        </Link>
      </div>
    </div>
  );
}
