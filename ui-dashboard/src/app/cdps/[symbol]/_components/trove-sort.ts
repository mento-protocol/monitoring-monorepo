import type { SortDir } from "@/lib/table-sort";
import type { CdpTrove } from "../../_lib/types";

export type TroveDisplayRow = {
  trove: CdpTrove;
  effectiveRate: bigint | null;
  rank: number | null;
  tied: boolean;
  rateSource: "direct" | "batch" | null;
};

export type TroveSortTab = "open" | "history";
export type OpenSortKey =
  | "rank"
  | "debt"
  | "collateral"
  | "icr"
  | "interest"
  | "updated";
export type HistorySortKey =
  | "opened"
  | "ended"
  | "remainingColl"
  | "redeemed"
  | "redemptionFee"
  | "liquidated";
export type TroveSortKey = OpenSortKey | HistorySortKey;

export const OPEN_SORT_KEYS: ReadonlySet<OpenSortKey> = new Set<OpenSortKey>([
  "rank",
  "debt",
  "collateral",
  "icr",
  "interest",
  "updated",
]);
export const HISTORY_SORT_KEYS: ReadonlySet<HistorySortKey> =
  new Set<HistorySortKey>([
    "opened",
    "ended",
    "remainingColl",
    "redeemed",
    "redemptionFee",
    "liquidated",
  ]);

export const OPEN_SORT_DEFAULT_KEY: OpenSortKey = "rank";
export const HISTORY_SORT_DEFAULT_KEY: HistorySortKey = "ended";
export const OPEN_SORT_DEFAULT_DIR: SortDir = "asc";
export const HISTORY_SORT_DEFAULT_DIR: SortDir = "desc";

/**
 * Sort display rows by the chosen column. Rows whose sort value is unavailable
 * (null effectiveRate, ICR sentinel `< 0`, never-liquidated) always sort last,
 * regardless of direction — so toggling asc/desc never floats "unknown" to the
 * top where it would read as a real extreme.
 */
export function sortDisplayRows(
  rows: readonly TroveDisplayRow[],
  tab: TroveSortTab,
  key: TroveSortKey,
  dir: SortDir,
): TroveDisplayRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const valueOf = (row: TroveDisplayRow): bigint | null =>
    tab === "open"
      ? openSortValue(key as OpenSortKey, row)
      : historySortValue(key as HistorySortKey, row);
  return [...rows].sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    if (av === null || bv === null) {
      if (av === bv) return tiebreakRows(a, b);
      return av === null ? 1 : -1;
    }
    if (av !== bv) return (av < bv ? -1 : 1) * sign;
    return tiebreakRows(a, b);
  });
}

/**
 * Direction-independent tiebreak shared by every sort key: order by numeric
 * trove id, then the composite entity id. Mirrors the tail of
 * {@link compareRedemptionPriorityRows} so the default rank sort is stable and
 * matches the indexer's redemption ordering exactly.
 */
function tiebreakRows(a: TroveDisplayRow, b: TroveDisplayRow): number {
  const byTroveId = compareNumericStrings(a.trove.troveId, b.trove.troveId);
  return byTroveId !== 0 ? byTroveId : a.trove.id.localeCompare(b.trove.id);
}

function openSortValue(key: OpenSortKey, row: TroveDisplayRow): bigint | null {
  const t = row.trove;
  switch (key) {
    case "rank":
    case "interest":
      return row.effectiveRate;
    case "debt":
      return parseBigInt(t.debt);
    case "collateral":
      return parseBigInt(t.coll);
    case "icr":
      return t.icrBps < 0 ? null : BigInt(t.icrBps);
    case "updated":
      return parseBigInt(t.lastUpdatedAt);
  }
}

function historySortValue(
  key: HistorySortKey,
  row: TroveDisplayRow,
): bigint | null {
  const t = row.trove;
  switch (key) {
    case "opened":
      return parseBigInt(t.openedAt);
    case "ended":
      return parseBigInt(t.closedAt ?? t.lastUpdatedAt);
    case "remainingColl":
      return parseBigInt(t.coll);
    case "redeemed":
      return parseBigInt(t.redeemedDebt);
    case "redemptionFee":
      return parseBigInt(t.redemptionFeePaidCum);
    case "liquidated":
      return t.liquidatedDebt == null ? null : parseBigInt(t.liquidatedDebt);
  }
}

export function compareRedemptionPriorityRows(
  a: TroveDisplayRow,
  b: TroveDisplayRow,
): number {
  const rate = compareNullableBigInt(a.effectiveRate, b.effectiveRate);
  if (rate !== 0) return rate;
  const troveId = compareNumericStrings(a.trove.troveId, b.trove.troveId);
  if (troveId !== 0) return troveId;
  return a.trove.id.localeCompare(b.trove.id);
}

function compareNullableBigInt(a: bigint | null, b: bigint | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareNumericStrings(a: string, b: string): number {
  const parsedA = parseBigInt(a);
  const parsedB = parseBigInt(b);
  if (parsedA != null && parsedB != null) {
    if (parsedA < parsedB) return -1;
    if (parsedA > parsedB) return 1;
    return 0;
  }
  return a.localeCompare(b);
}

export function parseBigInt(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}
