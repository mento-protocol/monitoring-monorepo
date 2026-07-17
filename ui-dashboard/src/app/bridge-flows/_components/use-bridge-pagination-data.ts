"use client";

import { useEffect, useMemo, useRef } from "react";
import { ENVIO_MAX_ROWS } from "@/lib/constants";
import { ALL_BRIDGE_STATUSES } from "@/lib/bridge-status";
import {
  BRIDGE_TRANSFERS_COUNT,
  BRIDGE_TRANSFERS_WINDOW,
} from "@/lib/bridge-queries";
import { buildBridgeTransferWhere } from "@/lib/bridge-flows/filters";
import { useBridgeGQL } from "@/lib/bridge-flows/use-bridge-gql";
import type { BridgeStatus, BridgeTransfer } from "@/lib/types";

export const BRIDGE_PAGE_LIMIT = 25;

type LastKnownTotal = { key: string; total: number };

function updateLastKnownTotal(
  ref: { current: LastKnownTotal },
  key: string,
  rawTotal: number,
): number {
  if (ref.current.key !== key) ref.current = { key, total: 0 };
  if (rawTotal > 0) ref.current.total = rawTotal;
  return ref.current.total;
}

export function useBridgePaginationData(
  rawPage: number,
  selectedStatus: BridgeStatus | null,
  sourceChainId: number | null,
  destChainId: number | null,
  setPage: (page: number) => void,
) {
  const where = useMemo(
    () =>
      buildBridgeTransferWhere(
        selectedStatus === null
          ? ALL_BRIDGE_STATUSES.slice()
          : [selectedStatus],
        sourceChainId,
        destChainId,
      ),
    [destChainId, selectedStatus, sourceChainId],
  );
  const countResult = useBridgeGQL<{ BridgeTransfer: Array<{ id: string }> }>(
    BRIDGE_TRANSFERS_COUNT,
    { where, limit: ENVIO_MAX_ROWS },
  );
  const filterKey = `${selectedStatus ?? "all"}:${sourceChainId ?? "all"}:${destChainId ?? "all"}`;
  const lastKnownTotalRef = useRef({ key: filterKey, total: 0 });
  const rawTotal = countResult.data?.BridgeTransfer.length ?? 0;
  const lastKnownTotal = updateLastKnownTotal(
    lastKnownTotalRef,
    filterKey,
    rawTotal,
  );
  const total = countResult.error ? lastKnownTotal : rawTotal;
  const totalCapped = !countResult.error && rawTotal >= ENVIO_MAX_ROWS;
  const totalPages = total > 0 ? Math.ceil(total / BRIDGE_PAGE_LIMIT) : 1;
  const page = Math.max(1, Math.min(rawPage, totalPages));
  const countReady =
    countResult.data !== undefined || countResult.error !== undefined;

  // The bounded page is synchronized to the browser URL only after the count
  // query resolves. This is external navigation state, not renderable derived
  // state; doing it during render would mutate history unsafely.
  // react-doctor-disable-next-line react-doctor/no-derived-state-effect
  useEffect(() => {
    if (countReady && page !== rawPage) {
      // react-doctor-disable-next-line effect/no-derived-state
      setPage(page);
    }
  }, [countReady, page, rawPage, setPage]);

  const transfersResult = useBridgeGQL<{ BridgeTransfer: BridgeTransfer[] }>(
    BRIDGE_TRANSFERS_WINDOW,
    {
      limit: BRIDGE_PAGE_LIMIT,
      offset: (page - 1) * BRIDGE_PAGE_LIMIT,
      where,
    },
  );
  return {
    countHasError: !!countResult.error,
    page,
    total,
    totalCapped,
    transfers: transfersResult.data?.BridgeTransfer ?? [],
    transfersResult,
  };
}
