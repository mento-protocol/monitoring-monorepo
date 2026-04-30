import { buildSearchBlob, matchesSearch } from "@/lib/table-search";
import type { OlsPool, Pool } from "@/lib/types";
import { MAX_TAB_LIMIT, type Tab } from "./constants";

export function addressSearchTerms(
  address: string | null | undefined,
  getName: (address: string | null) => string,
  getTags: (address: string | null) => string[],
): Array<string | null | undefined> {
  if (!address) return [];
  return [address, getName(address), ...getTags(address)];
}

export function matchesRowSearch(
  query: string,
  parts: Array<string | number | null | undefined>,
): boolean {
  return matchesSearch(buildSearchBlob(parts), query);
}

export function getTabLabel(tab: Tab) {
  if (tab === "providers") return "LPs";
  if (tab === "ols") return "OLS";
  if (tab === "breaches") return "Breaches";
  return tab;
}

export function getDebtTokenSideLabel(
  pool: Pool | null,
  debtToken: string,
): "token0" | "token1" | "unknown" {
  if (!pool?.token0 || !pool?.token1 || !debtToken) return "unknown";
  const normalizedDebtToken = debtToken.toLowerCase();
  if (pool.token0.toLowerCase() === normalizedDebtToken) return "token0";
  if (pool.token1.toLowerCase() === normalizedDebtToken) return "token1";
  return "unknown";
}

/**
 * Defensive selector for the current OLS row shown in the pool detail view.
 *
 * The GraphQL query already filters `isActive = true`, but this helper makes the
 * UI robust against stale/misconfigured query changes and gives us a focused
 * regression test for multi-registration pools.
 */
export function selectActiveOlsPool(
  rows: OlsPool[] | null | undefined,
): OlsPool | null {
  if (!rows || rows.length === 0) return null;

  const activeRows = rows.filter((row) => row.isActive);
  if (activeRows.length === 0) return null;

  return (
    [...activeRows].sort(
      (a, b) => Number(b.updatedAtTimestamp) - Number(a.updatedAtTimestamp),
    )[0] ?? null
  );
}

export function decodePoolId(rawPoolId: string): string {
  try {
    return decodeURIComponent(rawPoolId);
  } catch {
    return rawPoolId;
  }
}

export function parseTabLimit(rawLimit: string | null): number {
  const parsed = Number(rawLimit ?? "25");
  if (!Number.isInteger(parsed) || parsed <= 0) return 25;
  return Math.min(parsed, MAX_TAB_LIMIT);
}
