"use client";

import { useCallback, useMemo } from "react";
import { useSession } from "next-auth/react";
import useSWR from "swr";
import type { AddressReportsIndex } from "@/lib/address-reports-shared";

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
      // Reports don't change often — 60s poll is plenty.
      refreshInterval: 60_000,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      fallbackData: { addresses: [] },
    },
  );

  // Pre-bucket addresses into a Set so per-row `hasReport` lookups are O(1).
  // Addresses arrive lowercased from the server.
  const addressSet = useMemo(
    () => new Set<string>(data?.addresses ?? []),
    [data],
  );

  const hasReport = useCallback(
    (address: string | null): boolean => {
      if (!address) return false;
      return addressSet.has(address.toLowerCase());
    },
    [addressSet],
  );

  return {
    data,
    hasReport,
    isLoading,
    error: error as Error | undefined,
    mutate,
  };
}
