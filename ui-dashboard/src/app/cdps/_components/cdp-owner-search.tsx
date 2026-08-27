"use client";

// Owner lookup for the support entry path (docs/PLAN-trove-history-page.md,
// "UI design → Route and entry points"): paste a borrower address on the
// /cdps overview and get every trove it owns or owned across markets, each
// linked to its history page. `CDP_TROVES_BY_OWNER` matches `previousOwner`
// too — the NFT burn handler zeroes `owner` on close and liquidation, so
// that is how the closed troves support asks about are found.
//
// URL state follows the overview's `history.replaceState` contract
// (`../_lib/use-cdp-overview-url-filters.ts`): initialized from
// `useSearchParams` for the SSR pass, written back composing with sibling
// params via `window.location.search`, canonicalized once on mount, and
// synced from popstate. The polling hook follows
// docs/pr-checklists/swr-polling-hasura.md: `useGQL`'s wrapper-owned 30s
// poll with focus/reconnect revalidation off, `timeoutMs` below the poll
// interval, the shared retry policy, and a Zod rollout guard.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { SWRResponse } from "swr";
import { EmptyBox, ErrorBox, StaleRefreshNotice } from "@/components/feedback";
import { TableSkeleton } from "@/components/skeletons";
import { Row, Table, Td, Th } from "@/components/table";
import { relativeTime } from "@/lib/format";
import { HASURA_TIMEOUT_MS, useGQL } from "@/lib/graphql";
import { CDP_TROVES_BY_OWNER } from "@/lib/queries";
import { hasErrorWithoutData } from "@/lib/swr-state";
import { cdpSymbolSlug, formatTokenAmount } from "../_lib/format";
import {
  CDP_OWNER_SEARCH_RENDER_LIMIT,
  CDP_OWNER_SEARCH_REQUEST_LIMIT,
  CdpTrovesByOwnerSchema,
  isValidOwnerSearchAddress,
  normalizeOwnerSearchInput,
  paginateOwnerSearchRows,
  shortenTroveId,
  type CdpOwnerTroveRow,
  type CdpTrovesByOwnerResponse,
} from "../_lib/owner-search";
import type { CdpCollateral } from "../_lib/types";

const CDP_OWNER_QUERY_PARAM = "owner";

function readOwnerParam(params: URLSearchParams): string {
  return normalizeOwnerSearchInput(params.get(CDP_OWNER_QUERY_PARAM) ?? "");
}

function writeOwnerParamUrl(rawInput: string) {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  const normalized = normalizeOwnerSearchInput(rawInput);
  if (normalized === "") {
    params.delete(CDP_OWNER_QUERY_PARAM);
  } else {
    params.set(CDP_OWNER_QUERY_PARAM, normalized);
  }
  const search = params.toString();
  const nextUrl =
    window.location.pathname +
    (search ? `?${search}` : "") +
    window.location.hash;
  window.history.replaceState(window.history.state, "", nextUrl);
}

function useOwnerSearchUrlState() {
  // `useSearchParams()` is the SSR-pass source for direct `/cdps?owner=`
  // loads. Runtime writes/readbacks use `window.location.search` so our own
  // `replaceState` writes compose with the sibling filter params
  // (`type`/`market`/`address` from the transactions table).
  // react-doctor-disable-next-line react-doctor/nextjs-no-use-search-params-without-suspense
  const searchParams = useSearchParams();
  const initialParams =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : searchParams;
  const [ownerInput, setOwnerInputState] = useState(
    readOwnerParam(initialParams),
  );

  const setOwnerInput = useCallback((next: string) => {
    setOwnerInputState(next);
    writeOwnerParamUrl(next);
  }, []);

  // One-shot mount canonicalization (mirrors the overview filters hook): a
  // pasted `?owner=%200xAB…%20` re-renders trimmed + lowercased.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const current = new URLSearchParams(window.location.search);
    const next = readOwnerParam(current);
    setOwnerInputState((prev) => (prev === next ? prev : next));
    const raw = current.get(CDP_OWNER_QUERY_PARAM);
    if (raw != null && raw !== next) writeOwnerParamUrl(next);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPopState = () => {
      const next = readOwnerParam(new URLSearchParams(window.location.search));
      setOwnerInputState((prev) => (prev === next ? prev : next));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return { ownerInput, setOwnerInput };
}

/** Section chrome shared with the Suspense fallback in
 *  `cdps-page-client.tsx` so the fallback→hydrated swap keeps the heading
 *  and copy in place. */
export function CdpOwnerSearchShell({ children }: { children: ReactNode }) {
  return (
    <section aria-labelledby="cdp-owner-search-heading">
      <h2
        id="cdp-owner-search-heading"
        className="text-lg font-semibold text-white"
      >
        Find Troves by Owner
      </h2>
      <p className="mt-1 text-sm text-slate-400">
        Matches current and previous owners, so closed and liquidated troves are
        found too.
      </p>
      {children}
    </section>
  );
}

export function CdpOwnerSearch({
  collaterals,
  chainId,
}: {
  /** Undefined while the page's `CDP_MARKETS` fetch is still loading —
   *  results wait for it (market names and route slugs come from
   *  collateral rows), the input itself does not. */
  collaterals: readonly CdpCollateral[] | undefined;
  chainId: number;
}) {
  const { ownerInput, setOwnerInput } = useOwnerSearchUrlState();
  const normalized = normalizeOwnerSearchInput(ownerInput);
  const validAddress = isValidOwnerSearchAddress(normalized)
    ? normalized
    : null;
  const enabled = validAddress != null && chainId === 42220;
  const troves = useGQL<CdpTrovesByOwnerResponse>(
    enabled ? CDP_TROVES_BY_OWNER : null,
    enabled
      ? {
          chainId,
          address: validAddress,
          limit: CDP_OWNER_SEARCH_REQUEST_LIMIT,
        }
      : undefined,
    { timeoutMs: HASURA_TIMEOUT_MS, schema: CdpTrovesByOwnerSchema },
  );

  return (
    <CdpOwnerSearchShell>
      <label className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="sr-only">Owner address</span>
        <input
          type="text"
          value={ownerInput}
          onChange={(e) => setOwnerInput(e.target.value)}
          placeholder="0x… owner address"
          spellCheck={false}
          autoComplete="off"
          aria-label="Find troves by owner address"
          className="w-96 max-w-full rounded border border-slate-700/60 bg-slate-900/40 px-2 py-1 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      </label>
      <OwnerSearchStates
        normalized={normalized}
        validAddress={validAddress}
        collaterals={collaterals}
        troves={troves}
      />
    </CdpOwnerSearchShell>
  );
}

function OwnerSearchStates({
  normalized,
  validAddress,
  collaterals,
  troves,
}: {
  normalized: string;
  validAddress: string | null;
  collaterals: readonly CdpCollateral[] | undefined;
  troves: SWRResponse<CdpTrovesByOwnerResponse>;
}) {
  if (normalized === "") return null;
  if (validAddress == null) {
    return (
      <p role="status" className="mt-2 text-xs text-amber-400">
        Not a valid address — expected 0x followed by 40 hex characters.
      </p>
    );
  }
  if (hasErrorWithoutData(troves.error, troves.data)) {
    return (
      <div className="mt-3">
        <ErrorBox message={`Owner search failed — ${troves.error.message}`} />
      </div>
    );
  }
  // `data == null` is the loading state, never an empty result
  // (docs/pr-checklists/swr-polling-hasura.md); the collaterals wait keeps a
  // deep-linked `?owner=` load from flashing unlinkable "unknown market"
  // rows while `CDP_MARKETS` is still in flight.
  if (troves.data == null || collaterals == null) {
    return (
      <div className="mt-3">
        <TableSkeleton rows={3} cols={6} variant="rows" />
      </div>
    );
  }
  const { rows, capped } = paginateOwnerSearchRows(troves.data.Trove);
  return (
    <div className="mt-3">
      <StaleRefreshNotice
        subject="Owner search"
        error={troves.error}
        className="mb-3"
      />
      {rows.length === 0 ? (
        <EmptyBox message="No troves indexed for this address." />
      ) : (
        <OwnerSearchResults
          rows={rows}
          capped={capped}
          collaterals={collaterals}
        />
      )}
    </div>
  );
}

function OwnerSearchResults({
  rows,
  capped,
  collaterals,
}: {
  rows: CdpOwnerTroveRow[];
  capped: boolean;
  collaterals: readonly CdpCollateral[];
}) {
  const collateralById = new Map(collaterals.map((c) => [c.id, c]));
  return (
    <>
      <Table aria-label="Troves by owner">
        <thead>
          <tr className="border-b border-slate-800">
            <Th>Market</Th>
            <Th>Trove</Th>
            <Th>Status</Th>
            <Th align="right">Debt</Th>
            <Th align="right">Collateral</Th>
            <Th align="right">Updated</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <OwnerTroveHitRow
              key={row.id}
              row={row}
              collateral={collateralById.get(row.collateralId)}
            />
          ))}
        </tbody>
      </Table>
      {capped && (
        <p role="status" className="px-1 pt-1 text-xs text-amber-400">
          Results capped — showing the {CDP_OWNER_SEARCH_RENDER_LIMIT} most
          recently updated troves for this address; older ones are not listed.
        </p>
      )}
    </>
  );
}

function OwnerTroveHitRow({
  row,
  collateral,
}: {
  row: CdpOwnerTroveRow;
  /** Undefined when the hit's market is not (yet) in the `CDP_MARKETS`
   *  response — a transient indexer gap. Rendered honestly: raw collateral
   *  id, no history link (the route needs the market's symbol slug). */
  collateral: CdpCollateral | undefined;
}) {
  return (
    <Row>
      <Td>
        {collateral ? (
          collateral.symbol
        ) : (
          <span
            className="font-mono text-xs text-slate-500"
            title={row.collateralId}
          >
            {row.collateralId}
          </span>
        )}
      </Td>
      <Td>
        {collateral ? (
          <Link
            href={`/cdps/${cdpSymbolSlug(collateral.symbol)}/troves/${encodeURIComponent(row.troveId)}`}
            title={row.troveId}
            aria-label={`View history for trove ${row.troveId}`}
            className="font-mono text-xs text-slate-300 hover:text-indigo-300 hover:underline focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            {shortenTroveId(row.troveId)}
          </Link>
        ) : (
          <span
            className="font-mono text-xs text-slate-300"
            title={row.troveId}
          >
            {shortenTroveId(row.troveId)}
          </span>
        )}
      </Td>
      <Td>{row.status}</Td>
      <Td align="right" mono>
        {formatTokenAmount(row.debt, collateral?.symbol ?? "").trimEnd()}
      </Td>
      <Td align="right" mono>
        {formatTokenAmount(row.coll, "USDm")}
      </Td>
      <Td align="right">{relativeTime(row.lastUpdatedAt)}</Td>
    </Row>
  );
}
