// Custom wheel handler for the oracle chart. We disable Plotly's built-in
// `scrollZoom` (which always zooms both axes simultaneously, jarring on a
// trackpad) and route scroll input by cursor position instead:
//
//   - over the plot area → zoom X around the cursor, leave Y untouched
//   - over the y-axis tick column → zoom Y around the cursor, leave X untouched
//   - anywhere else (margins, rangeslider) → pass through to the page
//
// `e.preventDefault()` fires only when we actually handle the event, so
// scrolling outside the chart's interactive zones still scrolls the page.

interface PlotArea {
  plotL: number;
  plotR: number;
  plotT: number;
  plotB: number;
}

interface ZoomContext {
  Plotly: PlotlyAPI;
  graphDiv: HTMLElement;
  area: PlotArea;
  delta: number;
}

interface PlotlyFullLayout {
  xaxis?: { range?: [string | number, string | number] };
  yaxis?: { range?: [number, number] };
  margin?: { l?: number; r?: number; t?: number; b?: number };
}

interface PlotlyAPI {
  relayout: (
    div: HTMLElement,
    update: Record<string, unknown>,
  ) => Promise<unknown>;
}

function computePlotArea(
  graphDiv: HTMLElement,
  layout: PlotlyFullLayout,
): PlotArea {
  const rect = graphDiv.getBoundingClientRect();
  const ml = layout.margin?.l ?? 0;
  const mr = layout.margin?.r ?? 0;
  const mt = layout.margin?.t ?? 0;
  const mb = layout.margin?.b ?? 0;
  // Plot bottom excludes the rangeslider strip (thickness 0.08 by default).
  const sliderThickness = rect.height * 0.08;
  return {
    plotL: ml,
    plotR: rect.width - mr,
    plotT: mt,
    plotB: rect.height - mb - sliderThickness,
  };
}

function zoomYAroundCursor(
  ctx: ZoomContext,
  yRange: [number, number],
  yPos: number,
): void {
  const [yMin, yMax] = yRange;
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return;
  const span = yMax - yMin;
  const frac = (ctx.area.plotB - yPos) / (ctx.area.plotB - ctx.area.plotT);
  const cursor = yMin + span * frac;
  const newSpan = span * (ctx.delta > 0 ? 1.1 : 1 / 1.1);
  void ctx.Plotly.relayout(ctx.graphDiv, {
    "yaxis.range": [cursor - newSpan * frac, cursor + newSpan * (1 - frac)],
  });
}

function zoomXAroundCursor(
  ctx: ZoomContext,
  xRange: [string | number, string | number],
  xPos: number,
): void {
  const xMin = new Date(xRange[0]).getTime();
  const xMax = new Date(xRange[1]).getTime();
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) return;
  const span = xMax - xMin;
  const frac = (xPos - ctx.area.plotL) / (ctx.area.plotR - ctx.area.plotL);
  const cursorMs = xMin + span * frac;
  const newSpan = span * (ctx.delta > 0 ? 1.1 : 1 / 1.1);
  void ctx.Plotly.relayout(ctx.graphDiv, {
    "xaxis.range": [
      new Date(cursorMs - newSpan * frac).toISOString(),
      new Date(cursorMs + newSpan * (1 - frac)).toISOString(),
    ],
  });
}

export function attachOracleWheelHandler(graphDiv: HTMLElement): () => void {
  const onWheel = (e: WheelEvent) => {
    const Plotly = (window as unknown as { Plotly?: PlotlyAPI }).Plotly;
    const layout = (graphDiv as unknown as { _fullLayout?: PlotlyFullLayout })
      ._fullLayout;
    if (!Plotly || !layout?.xaxis?.range || !layout.yaxis?.range) return;
    const rect = graphDiv.getBoundingClientRect();
    const xPos = e.clientX - rect.left;
    const yPos = e.clientY - rect.top;
    const area = computePlotArea(graphDiv, layout);
    const inYBounds = yPos > area.plotT && yPos < area.plotB;
    const overYAxis = xPos < area.plotL && inYBounds;
    const overPlot = xPos >= area.plotL && xPos <= area.plotR && inYBounds;
    if (!overYAxis && !overPlot) return;
    const delta = e.deltaY + e.deltaX;
    // Tiny deltas (common at the start/end of a trackpad gesture) are
    // dropped: we early-return BEFORE preventDefault so the browser still
    // gets to do whatever it normally would with sub-pixel scroll noise,
    // matching this module's "preventDefault only when we actually handle
    // the event" promise.
    if (Math.abs(delta) < 1) return;
    e.preventDefault();

    const ctx: ZoomContext = { Plotly, graphDiv, area, delta };
    if (overYAxis) {
      zoomYAroundCursor(ctx, layout.yaxis.range, yPos);
    } else {
      // Zoom X around the cursor — matches Plotly's default scrollZoom for X
      // but leaves Y untouched so a plot-area scroll never accidentally
      // rescales the price axis.
      zoomXAroundCursor(ctx, layout.xaxis.range, xPos);
    }
  };
  // The handler calls `e.preventDefault()` to suppress Plotly's default
  // scroll behavior; `{ passive: true }` would silently ignore that and
  // break the axis-aware zoom.
  // react-doctor-disable-next-line react-doctor/client-passive-event-listeners
  graphDiv.addEventListener("wheel", onWheel, { passive: false });
  return () => graphDiv.removeEventListener("wheel", onWheel);
}
