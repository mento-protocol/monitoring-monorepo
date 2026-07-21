"use client";

import { useCallback } from "react";
import type { VolumeRangeKey } from "@/lib/volume";
import type { RangeKey } from "@/lib/time-series";

export function useVolumeChartControls(
  range: VolumeRangeKey,
  updateRange: (next: VolumeRangeKey) => void,
): {
  chartRange: RangeKey;
  onChartRangeChange: (next: RangeKey) => void;
} {
  // `24h` and `7d` are not global chart RangeKeys. Their charts are hidden,
  // so this fallback only supplies a valid pill value if one renders later.
  const chartRange: RangeKey =
    range === "30d" || range === "90d" || range === "all" ? range : "7d";
  const onChartRangeChange = useCallback(
    (next: RangeKey) => {
      if (next === "7d" || next === "30d" || next === "90d" || next === "all") {
        updateRange(next);
      }
    },
    [updateRange],
  );
  return { chartRange, onChartRangeChange };
}
