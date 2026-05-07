"use client";

import { useCallback, useMemo } from "react";
import { useSession } from "next-auth/react";
import useSWR from "swr";
import type { AddressReportsIndex } from "@/lib/address-reports-shared";
import type { Scope } from "@/lib/address-labels-shared";

/**
 * Lightweight index of which addresses have a forensic report. Used to render
 * the 📄 indicator in the address book — only the addresses are loaded
 * (server-side HKEYS), not titles, bodies, or any other metadata.
 *
 * The full report body and metadata are fetched on-demand by
 * `AddressReportEditor` when the Forensic Report tab opens, keyed by
 * `address-reports:single:{addr}`.
 */

export const ADDRESS_REPORTS_INDEX_SWR_KEY = "address-reports:index";

async function fetchReportsIndex(): Promise<AddressReportsIndex> {
  const res = await fetch("/api/address-reports", {
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch reports index: ${res.status}`);
  }
  return (await res.json()) as AddressReportsIndex;
}

export function useAddressReportsIndex() {
  const { status } = useSession();
  const { data, isLoading, error, mutate } = useSWR<AddressReportsIndex>(
    status === "authenticated" ? ADDRESS_REPORTS_INDEX_SWR_KEY : null,
    fetchReportsIndex,
    {
      // Reports don't change often — 60s poll is plenty. Mirrors the
      // SWR-polling defaults from the project's swr-polling-hasura checklist.
      refreshInterval: 60_000,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      fallbackData: { global: [], chains: {} },
    },
  );

  // Pre-bucket addresses into per-scope sets so per-row `hasReport` lookups
  // are O(1) — addresses arrive lowercased from the server, no per-call
  // normalization needed beyond the input.
  const addressSets = useMemo(() => {
    const global = new Set<string>(data?.global ?? []);
    const chains = new Map<string, Set<string>>();
    for (const [chainId, list] of Object.entries(data?.chains ?? {})) {
      chains.set(chainId, new Set(list));
    }
    return { global, chains };
  }, [data]);

  const hasReport = useCallback(
    (address: string | null, scope?: Scope): boolean => {
      if (!address) return false;
      const lower = address.toLowerCase();
      if (scope === "global") return addressSets.global.has(lower);
      if (typeof scope === "number") {
        // Global reports apply to every chain — mirror useAddressLabels.getName's
        // chain → global fallback so a report saved at "All chains" surfaces
        // on per-chain rows too. Without this, contract rows whose default
        // scope is "global" never show their own report indicator.
        return (
          (addressSets.chains.get(String(scope))?.has(lower) ?? false) ||
          addressSets.global.has(lower)
        );
      }
      // No scope: cross-scope check (used by inline AddressLink, which
      // doesn't know which scope a report lives in).
      if (addressSets.global.has(lower)) return true;
      for (const set of addressSets.chains.values()) {
        if (set.has(lower)) return true;
      }
      return false;
    },
    [addressSets],
  );

  return {
    data,
    hasReport,
    isLoading,
    error: error as Error | undefined,
    mutate,
  };
}
