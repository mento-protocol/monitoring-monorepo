// Owner-lookup domain logic for the /cdps overview
// (docs/PLAN-trove-history-page.md, "UI design → Route and entry points"):
// input normalization/validation, the limit+1 sentinel pagination, and the
// row types for `CDP_TROVES_BY_OWNER`. Pure functions only — the SWR and
// URL wiring live in `../_components/cdp-owner-search.tsx`.

import { z } from "zod/mini";

// A person owns a handful of troves; only a contract (e.g. a reserve trove
// factory) exceeds this. Kept well below Hasura's 1,000-row hard cap so the
// limit+1 sentinel request is never itself capped.
export const CDP_OWNER_SEARCH_RENDER_LIMIT = 100;
export const CDP_OWNER_SEARCH_REQUEST_LIMIT = CDP_OWNER_SEARCH_RENDER_LIMIT + 1;

/** One trove hit as selected by `CDP_TROVES_BY_OWNER` — panel-sized: enough
 *  to name the market (via `collateralId`), link the history page (market
 *  slug + `troveId`), and show status/size/recency. */
export type CdpOwnerTroveRow = {
  id: string;
  collateralId: string;
  troveId: string;
  status: string;
  debt: string;
  coll: string;
  lastUpdatedAt: string;
};

export type CdpTrovesByOwnerResponse = {
  Trove: CdpOwnerTroveRow[];
};

/** Runtime guard for hosted-Hasura rollout drift
 *  (docs/pr-checklists/swr-polling-hasura.md). Every selected field is a
 *  long-deployed column, but a drifted response should fail as a typed
 *  `GraphQLSchemaError` instead of rendering garbage rows. */
export const CdpTrovesByOwnerSchema = z.object({
  Trove: z.array(
    z.object({
      id: z.string(),
      collateralId: z.string(),
      troveId: z.string(),
      status: z.string(),
      debt: z.string(),
      coll: z.string(),
      lastUpdatedAt: z.string(),
    }),
  ),
});

/** Normalize a pasted owner address to the canonical form the indexer
 *  stores (lowercase, whitespace-trimmed) — same contract as
 *  `normalizeAddressFilter` in `../_components/cdp-tx-filters.tsx`. */
export function normalizeOwnerSearchInput(raw: string): string {
  return raw.trim().toLowerCase();
}

const OWNER_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

/** True only for a full 20-byte hex address (already normalized). Partial
 *  input never fires the query — `Trove.owner` matching is exact `_eq`, so
 *  anything else can only return a misleading empty result. */
export function isValidOwnerSearchAddress(normalized: string): boolean {
  return OWNER_ADDRESS_PATTERN.test(normalized);
}

export type OwnerSearchPage = {
  rows: CdpOwnerTroveRow[];
  /** True only when the limit+1 sentinel row came back — never inferred
   *  from `length === limit` (a result of exactly the render limit is
   *  complete and says nothing). */
  capped: boolean;
};

export function paginateOwnerSearchRows(
  rows: readonly CdpOwnerTroveRow[],
  renderLimit: number = CDP_OWNER_SEARCH_RENDER_LIMIT,
): OwnerSearchPage {
  return {
    rows: rows.slice(0, renderLimit),
    capped: rows.length > renderLimit,
  };
}

/** Middle-ellipsize a long trove id for display — deliberate mirror of the
 *  private `shortenHex` in `../[symbol]/_components/trove-cells.tsx` (route
 *  components stay private; a change there should be echoed here). The full
 *  id stays in the link title. */
export function shortenTroveId(value: string): string {
  return value.length <= 13 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}
