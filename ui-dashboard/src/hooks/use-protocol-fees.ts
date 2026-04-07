"use client";

import { useMemo } from "react";
import { useNetwork } from "@/components/network-provider";
import { useGQL } from "@/lib/graphql";
import { PROTOCOL_FEE_TRANSFERS_ALL } from "@/lib/queries";
import {
  aggregateProtocolFees,
  type ProtocolFeeSummary,
} from "@/lib/protocol-fees";
import { SNAPSHOT_REFRESH_MS } from "@/lib/volume";
import type { ProtocolFeeTransfer } from "@/lib/types";

/**
 * Fetches protocol fee totals (all-time + 24h) for the current network.
 * Queries indexed ProtocolFeeTransfer entities via Hasura GraphQL.
 */
export function useProtocolFees(): {
  data: ProtocolFeeSummary | null;
  isLoading: boolean;
  error: Error | undefined;
} {
  const { network } = useNetwork();
  const {
    data: raw,
    error,
    isLoading,
  } = useGQL<{ ProtocolFeeTransfer: ProtocolFeeTransfer[] }>(
    PROTOCOL_FEE_TRANSFERS_ALL,
    { chainId: network.chainId },
    SNAPSHOT_REFRESH_MS,
  );

  const data = useMemo(() => {
    const transfers = raw?.ProtocolFeeTransfer;
    if (!transfers) return null;
    return aggregateProtocolFees(transfers);
  }, [raw]);

  return { data, isLoading, error };
}
