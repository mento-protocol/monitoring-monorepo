"use client";

import { useMemo } from "react";
import { useGQL } from "@/lib/graphql";
import { PROTOCOL_FEE_TRANSFERS_ALL } from "@/lib/queries";
import {
  aggregateProtocolFees,
  type ProtocolFeeSummary,
} from "@/lib/protocol-fees";
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
  const {
    data: raw,
    error,
    isLoading,
  } = useGQL<{ ProtocolFeeTransfer: ProtocolFeeTransfer[] }>(
    PROTOCOL_FEE_TRANSFERS_ALL,
    undefined,
    300_000, // 5 minutes
  );

  const data = useMemo(() => {
    const transfers = raw?.ProtocolFeeTransfer;
    if (!transfers) return null;
    return aggregateProtocolFees(transfers);
  }, [raw]);

  return { data, isLoading, error };
}
