"use client";

import { useEffect, useRef } from "react";
import { HASURA_TIMEOUT_MS, useGQL } from "@/lib/graphql";
import {
  CDP_TROVE_OPERATIONS,
  CDP_TROVE_OPERATIONS_NUMERIC,
} from "@/lib/queries";
import type { CdpTroveOperationsQuery } from "@/lib/__generated__/graphql";
import { CDP_TROVE_OPERATIONS_REQUEST_LIMIT } from "./params";

type OperationSchema = {
  TroveOperationEventType?: { fields: ReadonlyArray<{ name: string }> } | null;
};

function supportsNumericOrdering(schema: {
  data?: OperationSchema | undefined;
  error?: Error | undefined;
}) {
  return (
    schema.error == null &&
    schema.data?.TroveOperationEventType?.fields.some(
      ({ name }) => name === "logIndex",
    ) === true
  );
}

function orderingMessage(error: Error | undefined, numericRows: boolean) {
  return error != null
    ? "Operation ordering could not be checked. Results may omit newer operations when the history limit is reached."
    : !numericRows
      ? "Operation ordering is not yet confirmed. Results may omit newer operations when the history limit is reached."
      : null;
}

export function useTroveOperations(
  instanceId: string | null,
  troveId: string,
  enabled: boolean,
  schema: { data?: OperationSchema | undefined; error?: Error | undefined },
) {
  const supportsNumeric = supportsNumericOrdering(schema);
  const query =
    !enabled || instanceId == null
      ? null
      : supportsNumeric
        ? CDP_TROVE_OPERATIONS_NUMERIC
        : CDP_TROVE_OPERATIONS;
  const result = useGQL<CdpTroveOperationsQuery>(
    query,
    query == null
      ? undefined
      : { instanceId, troveId, limit: CDP_TROVE_OPERATIONS_REQUEST_LIMIT },
    { timeoutMs: HASURA_TIMEOUT_MS },
  );
  const identity = instanceId == null ? null : `${instanceId}:${troveId}`;
  const previous = useRef<{
    identity: string;
    data: CdpTroveOperationsQuery;
    numeric: boolean;
  } | null>(null);
  useEffect(() => {
    if (query == null || identity == null || result.data == null) return;
    previous.current = {
      identity,
      data: result.data,
      numeric: supportsNumeric,
    };
  }, [query, identity, result.data, supportsNumeric]);
  const retained =
    query != null && previous.current?.identity === identity
      ? previous.current
      : null;
  const data = result.data ?? retained?.data;
  // Track the provenance of retained rows. A numeric request in flight does
  // not upgrade the completeness of a previously capped legacy response.
  const numericRows =
    result.data != null ? supportsNumeric : retained?.numeric === true;
  const orderingNotice = orderingMessage(schema.error, numericRows);
  return {
    ...result,
    data,
    isLoading: data == null && result.isLoading,
    orderingNotice,
  };
}
