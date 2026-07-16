"use client";

import { useCallback, useState } from "react";
import type { RangeKey } from "@/lib/time-series";

export function useSnapshotHistoryRange({
  historyIsCapped,
  snapshotHistoryError,
  requestFullSnapshotHistory,
}: {
  historyIsCapped: boolean;
  snapshotHistoryError: Error | null;
  requestFullSnapshotHistory?: (() => Promise<void>) | undefined;
}) {
  const [range, setRange] = useState<RangeKey>("30d");
  const handleRangeChange = useCallback(
    (nextRange: RangeKey) => {
      setRange(nextRange);
      if (nextRange === "all" && historyIsCapped) {
        void requestFullSnapshotHistory?.();
      }
    },
    [historyIsCapped, requestFullSnapshotHistory],
  );
  const allHistoryUnavailable = range === "all" && historyIsCapped;

  return {
    range,
    handleRangeChange,
    allHistoryUnavailable,
    allHistoryLoading: allHistoryUnavailable && snapshotHistoryError === null,
    allHistoryFailed: allHistoryUnavailable && snapshotHistoryError !== null,
  };
}
