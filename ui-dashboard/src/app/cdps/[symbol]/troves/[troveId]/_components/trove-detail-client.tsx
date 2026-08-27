"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";
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
  reorderTroveOperationsChronologically,
} from "../_lib/params";
import { TroveDetailSkeleton } from "./trove-detail-skeleton";
import { TroveHeaderCard } from "./trove-header-card";
import {
  hasTroveLifetimeTotals,
  TroveLifetimeTotals,
} from "./trove-lifetime-totals";
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

/** The schema probe above can flip `supportsTroveLastUpdatedTxHash` mid
 *  session (a live Hasura deploy+resync completing), which swaps
 *  `resolveTroveByIdQuery`'s result to a different query STRING — a new SWR
 *  key, since `useGQL` keys on the query text (`src/lib/graphql.ts`). That
 *  drops the already-loaded row for this same trove back to `undefined`
 *  data, flashing the full skeleton or, if the new request then fails,
 *  replacing perfectly good cached data with a hard error. Mirrors the
 *  market page's `useStableCdpDetail` (`cdp-detail-client.tsx`): substitute
 *  back the last successful response for the SAME entity id while the new
 *  key's fetch is in flight or has failed, so a query-variant swap is
 *  invisible to the reader. Keeps `troveById.error` intact rather than
 *  clearing it: if the UPGRADED query itself then fails, that's a real
 *  revalidation failure behind the cached row — the caller's stale-refresh
 *  notice needs `error` populated (with `data` non-null) to disclose it,
 *  not silence. Only `data`/`isLoading` are the query-swap artifacts this
 *  substitutes away. */
function useStableTroveById(
  troveById: ReturnType<typeof useGQL<CdpTroveByIdResponse>>,
  troveEntityId: string | null,
): ReturnType<typeof useGQL<CdpTroveByIdResponse>> {
  const previous = useRef<{
    troveEntityId: string;
    data: CdpTroveByIdResponse;
  } | null>(null);

  useEffect(() => {
    if (troveEntityId == null || troveById.data == null) return;
    previous.current = { troveEntityId, data: troveById.data };
  }, [troveEntityId, troveById.data]);

  if (troveById.data != null || troveEntityId == null) return troveById;
  if (previous.current?.troveEntityId !== troveEntityId) return troveById;

  return {
    ...troveById,
    data: previous.current.data,
    isLoading: false,
  };
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

/** True only once the batch join has RESOLVED successfully with no matching
 *  row (`InterestBatch: []`) — distinct from still loading (`data ==
 *  null`) and from a failed request. Both a loading and a successful-empty
 *  join otherwise collapse to the same `undefined` rate; without this, a
 *  confirmed-missing batch row reads as "still loading" forever instead of
 *  the explicit "Batch missing" state the market table already shows for
 *  it (`trove-cells.tsx`). */
function resolveInterestBatchMissing(
  joinBatchId: string | null,
  data: CdpInterestBatchByIdResponse | undefined,
): boolean {
  return joinBatchId != null && data != null && data.InterestBatch.length === 0;
}

/** Only disclose a batch-rate refresh failure via the "last confirmed
 *  state" wording once SOMETHING was actually confirmed and is still on
 *  screen — a resolved rate OR a resolved-missing verdict (mirrors the
 *  markets/trove notices, which are only reachable past
 *  `hasErrorWithoutData`, i.e. with data present) — that specific wording
 *  would misstate a first-attempt failure as stale data.
 *  {@link resolveInterestBatchFirstLoadError} covers the complementary
 *  case: a first-load failure is still real information (Codex correctly
 *  flagged that collapsing it into the same silent dash as "still
 *  loading" hides that the query failed, not just hasn't resolved yet).
 *  `batchMissing` must be included here too — a poll failure after a
 *  confirmed-missing verdict is a refresh failure, not a first-load one,
 *  same class of bug as the trove-lookup fix below. */
function resolveInterestBatchNoticeError(
  resolvedBatchRate: string | null | undefined,
  batchMissing: boolean,
  error: Error | undefined,
): Error | undefined {
  return resolvedBatchRate != null || batchMissing ? error : undefined;
}

/** The complementary first-load case: an error with nothing ever
 *  confirmed — neither a rate nor a confirmed-missing verdict. Distinct
 *  from {@link resolveInterestBatchNoticeError} so the two never both fire
 *  for the same render — exactly one, or neither. */
function resolveInterestBatchFirstLoadError(
  resolvedBatchRate: string | null | undefined,
  batchMissing: boolean,
  error: Error | undefined,
): Error | undefined {
  return resolvedBatchRate == null && !batchMissing ? error : undefined;
}

type BatchRateProps = {
  displayedInterestRate: string | null;
  interestBatchError: Error | undefined;
  interestBatchFirstLoadError: Error | undefined;
  batchRateTimestamp: string | null;
  batchMissing: boolean;
};

/** Bundles every value derived from the `interestBatch` join into one call
 *  — split out of {@link TroveDetailClient} so its own complexity and
 *  line-count stay under the file's lint budget; the branching this
 *  replaces (5 separate resolver calls, each with its own conditional)
 *  lives here instead. */
function resolveBatchRateProps(
  trove: CdpTrove | undefined,
  joinBatchId: string | null,
  interestBatch: ReturnType<typeof useGQL<CdpInterestBatchByIdResponse>>,
): BatchRateProps {
  const resolvedBatchRate =
    interestBatch.data?.InterestBatch[0]?.annualInterestRate;
  const batchMissing = resolveInterestBatchMissing(
    joinBatchId,
    interestBatch.data,
  );
  return {
    displayedInterestRate: resolveDisplayedInterestRate(
      trove,
      joinBatchId,
      resolvedBatchRate,
    ),
    interestBatchError: resolveInterestBatchNoticeError(
      resolvedBatchRate,
      batchMissing,
      interestBatch.error,
    ),
    interestBatchFirstLoadError: resolveInterestBatchFirstLoadError(
      resolvedBatchRate,
      batchMissing,
      interestBatch.error,
    ),
    batchRateTimestamp:
      joinBatchId == null
        ? null
        : (interestBatch.data?.InterestBatch[0]?.updatedAt ?? null),
    batchMissing,
  };
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
  const troveById = useStableTroveById(
    useGQL<CdpTroveByIdResponse>(
      resolveTroveByIdQuery(troveEntityId, supportsTroveLastUpdatedTxHash),
      troveEntityId == null ? undefined : { troveEntityId },
      { timeoutMs: HASURA_TIMEOUT_MS },
    ),
    troveEntityId,
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
    () =>
      paginateTroveOperations(
        reorderTroveOperationsChronologically(
          operations.data?.TroveOperationEvent ?? [],
        ),
      ),
    [operations.data],
  );

  if (network.chainId !== CELO_MAINNET_CHAIN_ID) {
    return (
      <EmptyBox message="CDP markets are only deployed on Celo mainnet." />
    );
  }
  return (
    <TroveDetailView
      symbol={symbol}
      troveId={troveId}
      network={network}
      markets={markets}
      collateral={collateral}
      troveById={troveById}
      trove={trove}
      {...resolveBatchRateProps(trove, joinBatchId, interestBatch)}
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
  interestBatchFirstLoadError,
  batchRateTimestamp,
  batchMissing,
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
  interestBatchFirstLoadError: Error | undefined;
  batchRateTimestamp: string | null;
  batchMissing: boolean;
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
    return <UnknownMarketNotice marketsError={markets.error} />;
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
        troveError={troveById.error}
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
      <TroveDetailNotices
        marketsError={markets.error}
        troveError={troveById.error}
        interestBatchError={interestBatchError}
        interestBatchFirstLoadError={interestBatchFirstLoadError}
      />
      <TroveHeaderCard
        trove={trove}
        collateral={collateral}
        displayedInterestRate={displayedInterestRate}
        batchRateTimestamp={batchRateTimestamp}
        batchMissing={batchMissing}
      />
      <TroveLifetimeTotals trove={trove} debtSymbol={collateral.symbol} />
      <TroveOperationsList
        rows={operationRows}
        truncated={truncated}
        isLoading={operations.isLoading}
        error={operations.error}
        // `operations.data != null`, not `operationRows.length > 0`: the
        // latter can't tell "never loaded" from "loaded, confirmed empty"
        // (see the prop's doc comment on TroveOperationsList).
        hasLoadedOnce={operations.data != null}
        hasLifetimeTotals={hasTroveLifetimeTotals(trove)}
        chainId={collateral.chainId}
        debtSymbol={collateral.symbol}
      />
    </div>
  );
}

/** The page's four stale/failed-refresh disclosures — split out of
 *  {@link TroveDetailView} to stay under the file's max-lines-per-function
 *  lint budget. A revalidation failure after any of these queries has
 *  already succeeded once leaves `data` populated
 *  (`hasErrorWithoutData` in {@link TroveDetailView} is false), so the
 *  header keeps rendering below — these disclose that it's the last
 *  confirmed state rather than a silently-stalled poll. */
function TroveDetailNotices({
  marketsError,
  troveError,
  interestBatchError,
  interestBatchFirstLoadError,
}: {
  marketsError: Error | undefined;
  troveError: Error | undefined;
  interestBatchError: Error | undefined;
  interestBatchFirstLoadError: Error | undefined;
}) {
  return (
    <>
      <StaleRefreshNotice
        subject="Market data"
        error={marketsError}
        className="mb-3"
      />
      <StaleRefreshNotice
        subject="Trove data"
        error={troveError}
        className="mb-3"
      />
      <StaleRefreshNotice
        subject="Batch rate"
        error={interestBatchError}
        className="mb-3"
      />
      {/* Distinct from StaleRefreshNotice above: a first-load batch-rate
          failure has nothing "last confirmed" to point to, so it gets its
          own honest wording instead of borrowing that one's phrasing. */}
      {interestBatchFirstLoadError != null && (
        <div className="mb-3">
          <ErrorBox
            message={`Batch rate unavailable — ${interestBatchFirstLoadError.message}`}
          />
        </div>
      )}
    </>
  );
}

/** By the time this renders, `hasErrorWithoutData` above has already
 *  returned for a first-load failure, so `markets.data` is guaranteed
 *  non-null — any `marketsError` here is necessarily a refresh failure on
 *  a confirmed (just symbol-less) response, same class as
 *  `NotIndexedNotice` below. During indexer catch-up or a market rollout,
 *  this symbol may have appeared since the last successful poll — split
 *  out of {@link TroveDetailView} to keep it under the file's
 *  max-lines-per-function budget. */
function UnknownMarketNotice({
  marketsError,
}: {
  marketsError: Error | undefined;
}) {
  return (
    <div className="space-y-3">
      <StaleRefreshNotice
        subject="Market data"
        error={marketsError}
        className=""
      />
      <EmptyBox message="Unknown CDP market." />
    </div>
  );
}

function NotIndexedNotice({
  troveId,
  collateral,
  symbol,
  network,
  troveError,
}: {
  troveId: string;
  collateral: CdpCollateral;
  symbol: string;
  network: Network;
  /** By the time this component renders, `troveById.data` is guaranteed
   *  non-null (the earlier `isLoadingWithoutData`/`hasErrorWithoutData`
   *  guards already returned for a still-loading or first-load-failed
   *  request) — so any error here is necessarily a REFRESH failure on top
   *  of an already-confirmed empty `Trove: []` response, never a
   *  first-load failure. During indexer catch-up the trove may have
   *  appeared since that last successful lookup; silently keeping the
   *  "not indexed" claim on a failed refresh would misstate it as current. */
  troveError: Error | undefined;
}) {
  return (
    <div className="space-y-3">
      <StaleRefreshNotice
        subject="Trove data"
        error={troveError}
        className=""
      />
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
