"use client";

// The trove history page's disclosure/empty states, split out of
// `trove-detail-client.tsx` to keep that file under the 600-line soft cap
// as the ledger wiring lands (#2086). Behavior is unchanged from the page
// shell; every comment below is load-bearing for why each state renders
// what it does.

import Link from "next/link";
import { EmptyBox, ErrorBox, StaleRefreshNotice } from "@/components/feedback";
import type { Network } from "@/lib/networks";
import { explorerAddressUrl } from "@/lib/tokens";
import type { CdpCollateral } from "../../../../_lib/types";

/** The page's four stale/failed-refresh disclosures. A revalidation failure
 *  after any of these queries has already succeeded once leaves `data`
 *  populated (`hasErrorWithoutData` in the caller is false), so the header
 *  keeps rendering below — these disclose that it's the last confirmed
 *  state rather than a silently-stalled poll. */
export function TroveDetailNotices({
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

/** By the time this renders, the caller's `hasErrorWithoutData` guard has
 *  already returned for a first-load failure, so `markets.data` is
 *  guaranteed non-null — any `marketsError` here is necessarily a refresh
 *  failure on a confirmed (just symbol-less) response, same class as
 *  `NotIndexedNotice` below. During indexer catch-up or a market rollout,
 *  this symbol may have appeared since the last successful poll. */
export function UnknownMarketNotice({
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

export function NotIndexedNotice({
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
