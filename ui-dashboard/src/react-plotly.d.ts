// Ambient declarations for the lean Plotly build wiring used by
// `@/lib/react-plotly-basic`. Neither the `basic-dist-min` bundle nor the
// react-plotly.js `/factory` entry ship their own types.

declare module "plotly.js-basic-dist-min" {
  // The runtime Plotly object is only ever handed to `createPlotlyComponent`,
  // which treats it opaquely, so `unknown` is sufficient and avoids depending on
  // the (unbundled) `@types/plotly.js` module surface.
  const Plotly: unknown;
  export default Plotly;
}

declare module "react-plotly.js/factory" {
  import type { PlotParams } from "react-plotly.js";
  import type { ComponentType } from "react";

  export default function createPlotlyComponent(
    plotly: unknown,
  ): ComponentType<PlotParams>;
}
