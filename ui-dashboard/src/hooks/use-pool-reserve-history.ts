"use client";

import useSWR from "swr";
import { useEffect, useMemo } from "react";
import { useNetwork } from "@/components/network-provider";
import { SHARED_QUERY_SWR_CONFIG } from "@/lib/gql-retry";
import { resolveGraphqlEndpoint } from "@/lib/graphql-endpoint";
import type { ReserveHistoryRange } from "@/lib/pool-reserve-history";
import { createReserveHistoryResource } from "@/lib/reserve-history-resource";
import { SNAPSHOT_REFRESH_MS } from "@/lib/volume";

export function usePoolReserveHistory(
  poolId: string,
  range: ReserveHistoryRange,
  enabled = true,
) {
  const { network } = useNetwork();
  const endpoint = resolveGraphqlEndpoint(network.hasuraUrl);
  const resource = useMemo(
    () => ({
      ...createReserveHistoryResource(endpoint, poolId, range),
      key:
        endpoint && enabled
          ? ["pool-reserve-history", network.id, endpoint, poolId, range]
          : null,
    }),
    [endpoint, network.id, poolId, range, enabled],
  );
  useEffect(() => resource.retain(), [resource]);
  const result = useSWR(resource.key, resource.fetch, {
    ...SHARED_QUERY_SWR_CONFIG,
    refreshInterval: (data) => (data?.truncated ? 0 : SNAPSHOT_REFRESH_MS),
    shouldRetryOnError: (error) => error?.name !== "AbortError",
  });
  return {
    ...result,
    error: endpoint
      ? result.error
      : new Error("Reserve history endpoint is not configured."),
  };
}
