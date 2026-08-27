// Route params + interim-assembly constants for the trove history page
// (docs/PLAN-trove-history-page.md, "UI design → Route and entry points").

// The on-chain hex trove id: `0x` + up to 64 hex digits (a uint256), lowercase
// once normalized — matches the indexer's `normalizeTroveTokenId`
// (indexer-envio/src/handlers/liquity/troves.ts). No fixed length: unlike an
// address, a trove id's `toString(16)` drops leading zeros.
const TROVE_ID_PATTERN = /^0x[0-9a-fA-F]{1,64}$/;

export function isValidTroveIdParam(value: string): boolean {
  return TROVE_ID_PATTERN.test(value);
}

/** Normalize a route troveId param to match the indexer's stored id. Only
 *  meaningful after {@link isValidTroveIdParam} confirms the shape. Lowercases
 *  AND strips leading zeros: the indexer stores `` `0x${troveId.toString(16)}` ``
 *  (`normalizeTroveTokenId`, indexer-envio/src/handlers/liquity/troves.ts),
 *  and `bigint.toString(16)` never carries leading zeros. A trove id copied in
 *  its common 32-byte ABI form (`0x000…0001`) would otherwise pass validation,
 *  get lowercased to the same padded string, and then fail the entity lookup
 *  against the indexer's unpadded `0x1` — read as "not indexed" instead of
 *  resolving. Round-tripping through `BigInt` matches the indexer exactly
 *  (including collapsing `0x000` to `0x0`) rather than a regex strip, which
 *  would need its own "how many zeros are actually leading" edge cases.
 *  `BigInt` accepts a `0x`-prefixed literal directly. */
export function normalizeTroveIdParam(value: string): string {
  return `0x${BigInt(value).toString(16)}`;
}

/** Mirrors the indexer's `makeTroveId` (indexer-envio/src/handlers/liquity/
 *  troves.ts) — the `Trove.id` composite key. `troveId` must already be
 *  normalized (lowercase, `0x`-prefixed). */
export function makeTroveEntityId(
  collateralId: string,
  troveId: string,
): string {
  return `${collateralId}-${troveId}`;
}

// The interim op-list query requests `limit + 1` rows so a full response
// carries a sentinel row proving more history exists — Hasura aggregates are
// disabled on hosted Hasura, so `length === limit` alone can't distinguish
// "exactly this many rows" from "more rows exist beyond the cap"
// (docs/PLAN-trove-history-page.md, "GraphQL contract → interim assembly").
// The render limit must sit below the 1,000-row Hasura hard cap so a fully
// capped response can still carry the +1 sentinel.
export const CDP_TROVE_OPERATIONS_RENDER_LIMIT = 999;
export const CDP_TROVE_OPERATIONS_REQUEST_LIMIT =
  CDP_TROVE_OPERATIONS_RENDER_LIMIT + 1;

export type TroveOperationsPage<TRow> = {
  /** Rows to render, oldest first, capped at the render limit. */
  rows: TRow[];
  /** True only when the sentinel row came back — never derived from
   *  `rows.length === renderLimit` alone (a history of exactly the render
   *  limit is complete and says nothing). */
  truncated: boolean;
};

/** Applies the limit+1 sentinel rule to a desc-ordered fetch: drops the
 *  sentinel row (if present) and reverses to chronological (oldest-first)
 *  order for display. `truncated` is true only when the fetch returned more
 *  than the render limit. */
export function paginateTroveOperations<TRow>(
  descRows: readonly TRow[],
  renderLimit: number = CDP_TROVE_OPERATIONS_RENDER_LIMIT,
): TroveOperationsPage<TRow> {
  const truncated = descRows.length > renderLimit;
  const kept = truncated ? descRows.slice(0, renderLimit) : descRows;
  return { rows: [...kept].reverse(), truncated };
}
