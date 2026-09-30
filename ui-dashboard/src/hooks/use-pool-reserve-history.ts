"use client";

import useSWR from "swr";
import { useNetwork } from "@/components/network-provider";
import { SHARED_QUERY_SWR_CONFIG } from "@/lib/gql-retry";
import { resolveGraphqlEndpoint } from "@/lib/graphql-endpoint";
import {
  fetchPoolReserveHistory,
  type ReserveHistoryRange,
} from "@/lib/pool-reserve-history";

export function usePoolReserveHistory(
  poolId: string,
  range: ReserveHistoryRange,
  enabled = true,
) {
  const { network } = useNetwork();
  const endpoint = resolveGraphqlEndpoint(network.hasuraUrl);
  const result = useSWR(
    endpoint && enabled
      ? ["pool-reserve-history", network.id, endpoint, poolId, range]
      : null,
    () => fetchPoolReserveHistory(endpoint, poolId, range),
    { ...SHARED_QUERY_SWR_CONFIG, refreshInterval: 0 },
  );
  return {
    ...result,
    error: endpoint
      ? result.error
      : new Error("Reserve history endpoint is not configured."),
  };
}
