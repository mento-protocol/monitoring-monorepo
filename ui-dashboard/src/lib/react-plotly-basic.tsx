"use client";

// `react-plotly.js` defaults to importing the full `plotly.js` build, which bundles
// mapbox-gl + WebGL renderers we never use — every chart in this app draws only
// scatter/bar/pie traces. Build the Plot component against the lean
// `plotly.js-basic-dist-min` bundle instead, and share that single component across
// every chart via one dynamically-imported chunk.
//
// IMPORTANT: keep this module reachable ONLY through `next/dynamic(() => import(...))`
// so the Plotly bytes stay in their own async chunk. Do not re-export it from a module
// (e.g. `@/lib/plot`) that non-chart code imports, or Plotly leaks back into the shared
// bundle and this optimization is undone.
import Plotly from "plotly.js-basic-dist-min";
import createPlotlyComponent from "react-plotly.js/factory";

const Plot = createPlotlyComponent(Plotly);

export default Plot;
