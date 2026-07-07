"use client";

// `react-plotly.js` binds to its `plotly.js` peer. package.json intentionally
// aliases that peer to `plotly.js-basic-dist-min`, which excludes mapbox-gl and
// WebGL renderers we never use — every chart in this app draws only
// scatter/bar/pie traces. Build the Plot component against that lean bundle
// explicitly, and share the single component across every chart via one
// dynamically-imported chunk.
//
// IMPORTANT: keep this module reachable ONLY through `next/dynamic(() => import(...))`
// so the Plotly bytes stay in their own async chunk. Do not re-export it from a module
// (e.g. `@/lib/plot`) that non-chart code imports, or Plotly leaks back into the shared
// bundle and this optimization is undone.
import { useId } from "react";
import Plotly from "plotly.js-basic-dist-min";
import createPlotlyComponent from "react-plotly.js/factory";
import type { PlotParams } from "react-plotly.js";

const RawPlot = createPlotlyComponent(Plotly);

type AccessiblePlotProps = PlotParams & {
  ariaLabel: string;
  textAlternative: string;
  ariaHidden?: boolean;
};

export default function AccessiblePlot({
  ariaLabel,
  textAlternative,
  ariaHidden = false,
  ...plotProps
}: AccessiblePlotProps) {
  const summaryId = useId();

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      aria-describedby={summaryId}
      aria-hidden={ariaHidden || undefined}
    >
      <RawPlot {...plotProps} />
      <span id={summaryId} className="sr-only">
        {textAlternative}
      </span>
    </div>
  );
}
