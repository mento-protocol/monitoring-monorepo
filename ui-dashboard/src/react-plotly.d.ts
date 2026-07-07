// Ambient declarations for the lean Plotly build wiring used by
// `@/lib/react-plotly-basic`. react-plotly.js v4 ships first-party types for
// the `/factory` entry, but the `basic-dist-min` bundle remains untyped.

declare module "plotly.js-basic-dist-min" {
  // The runtime Plotly object is only ever handed to `createPlotlyComponent`,
  // which treats it opaquely, so `unknown` matches the wrapper contract.
  const Plotly: unknown;
  export default Plotly;
}
