import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/dynamic", () => ({
  default: () =>
    function MockPlot() {
      return React.createElement("div", { "data-testid": "plot" });
    },
}));

vi.mock("@/lib/use-pool-snapshots", () => ({
  usePoolSnapshots: () => ({
    snapshots: [],
    bucketSeconds: 86_400,
    isLoading: true,
    hasError: false,
  }),
}));

import { PoolVolumeOverTimeChart } from "@/components/pool-volume-over-time-chart";
import { TVL_NETWORK, makeTvlPool } from "@/test-utils/network-fixtures";

describe("PoolVolumeOverTimeChart", () => {
  it("renders an exact all-time zero while snapshot history is still loading", () => {
    const pool = makeTvlPool({
      notionalVolume0: "0",
      notionalVolume1: "0",
    });

    const html = renderToStaticMarkup(
      React.createElement(PoolVolumeOverTimeChart, {
        poolId: pool.id,
        pool,
        network: TVL_NETWORK,
        isLoading: false,
        hasError: false,
      }),
    );

    expect(html).toContain("$0.00");
    expect(html).not.toContain("h-[1em] w-36");
    expect(html).toContain("animate-pulse");
  });
});
