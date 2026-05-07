"use client";

import { useCallback } from "react";
import { useSession } from "next-auth/react";
import useSWR from "swr";
import type { AddressReportSummary } from "@/lib/address-reports-shared";
import type { Scope } from "@/lib/address-labels-shared";

/**
 * Lightweight index of which addresses have a forensic report. Used to render
 * the 📄 indicator in the address book — bodies are NOT loaded here, only
 * metadata (title, length, author, version, updatedAt).
 *
 * The full report body is fetched on-demand by `AddressReportEditor` when the
 * Forensic Report tab opens, keyed by `address-reports:single:{addr}`.
 */

export const ADDRESS_REPORTS_INDEX_SWR_KEY = "address-reports:index";

type IndexResponse = {
  global: AddressReportSummary[];
  chains: Record<string, AddressReportSummary[]>;
};

async function fetchReportsIndex(): Promise<IndexResponse> {
  const res = await fetch("/api/address-reports", {
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch reports index: ${res.status}`);
  }
  return (await res.json()) as IndexResponse;
}

export function useAddressReportsIndex() {
  const { status } = useSession();
  const { data, isLoading, error, mutate } = useSWR<IndexResponse>(
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

  const hasReport = useCallback(
    (address: string | null, scope?: Scope): boolean => {
      if (!address || !data) return false;
      const lower = address.toLowerCase();
      // Strict either/or means a row exists in at most one scope. When the
      // caller passes a specific scope, check only that scope. When no scope
      // is provided, scan all scopes so the indicator works on UI surfaces
      // (like inline AddressLink) that don't know which scope a report lives
      // in.
      if (scope === "global") {
        return data.global.some((r) => r.address.toLowerCase() === lower);
      }
      if (typeof scope === "number") {
        return (
          data.chains[String(scope)]?.some(
            (r) => r.address.toLowerCase() === lower,
          ) ?? false
        );
      }
      if (data.global.some((r) => r.address.toLowerCase() === lower)) {
        return true;
      }
      for (const list of Object.values(data.chains)) {
        if (list.some((r) => r.address.toLowerCase() === lower)) return true;
      }
      return false;
    },
    [data],
  );

  return {
    data,
    hasReport,
    isLoading,
    error: error as Error | undefined,
    mutate,
  };
}
