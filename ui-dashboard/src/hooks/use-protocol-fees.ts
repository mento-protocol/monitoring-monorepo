"use client";

import useSWR from "swr";
import { useNetwork } from "@/components/network-provider";
import {
  fetchProtocolFeeSummary,
  type ProtocolFeeSummary,
} from "@/lib/protocol-fees";

/**
 * Fetches protocol fee totals (all-time + 24h) for the current network.
 * Queries ERC20 Transfer events to the yield split address via RPC.
 */
export function useProtocolFees(): {
  data: ProtocolFeeSummary | null;
  isLoading: boolean;
  error: Error | undefined;
} {
  const { network } = useNetwork();
  const key = network.rpcUrl ? `protocol-fees:${network.id}` : null;

  const { data, error, isLoading } = useSWR<ProtocolFeeSummary>(
    key,
    () => fetchProtocolFeeSummary(network.rpcUrl!, network),
    {
      refreshInterval: 300_000, // 5 minutes
      revalidateOnFocus: false,
      dedupingInterval: 120_000,
      shouldRetryOnError: false,
    },
  );

  return {
    data: data ?? null,
    isLoading: !!key && isLoading,
    error,
  };
}
