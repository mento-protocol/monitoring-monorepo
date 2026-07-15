"use client";

import { useEffect } from "react";

type PlotlyModuleLoader = () => Promise<unknown>;
type PlotlyPreloadScheduler = () => void;

export function createPlotlyIdlePreloadScheduler(
  loadPlotly: PlotlyModuleLoader,
): PlotlyPreloadScheduler {
  let scheduled = false;

  return () => {
    if (scheduled) return;
    scheduled = true;

    const load = () => {
      void loadPlotly().catch(() => {
        // Chunk failed to load (offline, blocked) — charts still load on demand.
      });
    };

    // Match the route-independent Sentry Replay preload: busy tabs get a
    // bounded 1.5s wait, and older Safari gets the same post-hydration delay.
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(load, { timeout: 1_500 });
    } else {
      window.setTimeout(load, 1_500);
    }
  };
}

const schedulePlotlyIdlePreload = createPlotlyIdlePreloadScheduler(
  () => import("@/lib/react-plotly-basic"),
);

export function PlotlyIdlePreloader({
  schedule = schedulePlotlyIdlePreload,
}: {
  schedule?: PlotlyPreloadScheduler;
}) {
  // The singleton scheduler owns the page-load lifecycle. Deliberately do not
  // cancel it during effect cleanup: React Strict Mode remounts effects in
  // development, and the guarded first schedule must still get to fire once.
  useEffect(() => {
    schedule();
  }, [schedule]);

  return null;
}
