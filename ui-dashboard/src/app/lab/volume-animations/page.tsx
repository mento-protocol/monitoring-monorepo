"use client";

// Temporary lab page — pick an animation strategy for the volume-chart
// stacked legend toggle, then we revert this file before merge.
//
// Each variant mounts the same Plotly stacked-area chart with the same
// mock v3+v2 data. The "Toggle v2" button hides/shows v2 and runs the
// variant-specific animation. Click the toggle a few times in each
// variant and pick a winner.

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

const V3_COLOR = "#6366f1";
const V2_COLOR = "#14b8a6";
const CHART_HEIGHT = 240;

// Mock 30 days of v3+v2 daily volume, shaped roughly like production.
function buildMockData() {
  const days = 30;
  const now = Math.floor(Date.now() / 1000);
  const SECS_PER_DAY = 86_400;
  const xs: string[] = [];
  const v3: number[] = [];
  const v2: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const ts = now - i * SECS_PER_DAY;
    xs.push(new Date(ts * 1000).toISOString());
    // v3: $50k–$400k with one spike
    v3.push(50_000 + Math.random() * 350_000 + (i === 5 ? 600_000 : 0));
    // v2: $200k–$3M with a few peaks
    v2.push(
      200_000 +
        Math.random() * 700_000 +
        (i === 3 ? 2_500_000 : 0) +
        (i === 12 ? 1_800_000 : 0),
    );
  }
  return { xs, v3, v2 };
}

interface ChartTraceData {
  x: string[];
  y: number[];
  name: string;
  type: "scatter";
  mode: "lines";
  stackgroup: string;
  line: { color: string; width: number };
  fillcolor: string;
  visible?: boolean | "legendonly";
  opacity?: number;
}

function makeTraces(
  data: { xs: string[]; v3: number[]; v2: number[] },
  opts: {
    v2Hidden?: boolean;
    v2Visible?: boolean | "legendonly";
    v2Opacity?: number;
    v2YOverride?: number[];
  } = {},
): ChartTraceData[] {
  const v3: ChartTraceData = {
    x: data.xs,
    y: data.v3,
    name: "v3",
    type: "scatter",
    mode: "lines",
    stackgroup: "total",
    line: { color: V3_COLOR, width: 1.2 },
    fillcolor: V3_COLOR + "cc",
  };
  const v2: ChartTraceData = {
    x: data.xs,
    y: opts.v2YOverride ?? data.v2,
    name: "v2",
    type: "scatter",
    mode: "lines",
    stackgroup: "total",
    line: { color: V2_COLOR, width: 1.2 },
    fillcolor: V2_COLOR + "cc",
  };
  if (opts.v2Visible !== undefined) v2.visible = opts.v2Visible;
  if (opts.v2Opacity !== undefined) v2.opacity = opts.v2Opacity;
  return [v3, v2];
}

const BASE_LAYOUT = {
  paper_bgcolor: "transparent",
  plot_bgcolor: "transparent",
  font: { color: "#e2e8f0", size: 11, family: "inherit" },
  xaxis: {
    type: "date" as const,
    showgrid: false,
    showline: false,
    zeroline: false,
    tickfont: { size: 10, color: "#64748b" },
    nticks: 5,
    tickformat: "%b %d",
    fixedrange: true,
  },
  showlegend: true,
  legend: {
    orientation: "h" as const,
    y: -0.2,
    x: 0,
    font: { color: "#94a3b8", size: 11 },
    bgcolor: "transparent",
  },
  margin: { t: 8, r: 8, b: 48, l: 8 },
  autosize: true,
  dragmode: false as const,
  hovermode: "x unified" as const,
};

type PlotlyEasing =
  | "linear"
  | "cubic-out"
  | "cubic-in-out"
  | "back-out"
  | "back-in-out";

function makeLayout(
  opts: {
    yRange?: [number, number];
    autorange?: boolean;
    transition?: { duration: number; easing: PlotlyEasing };
  } = {},
) {
  return {
    ...BASE_LAYOUT,
    yaxis: {
      showgrid: false,
      showticklabels: false,
      showline: false,
      zeroline: false,
      fixedrange: true,
      ...(opts.yRange
        ? { range: opts.yRange }
        : { autorange: true as const, rangemode: "tozero" as const }),
    },
    ...(opts.transition ? { transition: opts.transition } : {}),
  };
}

// Compute the y-range max for a stacked v3+v2 series (per-day sum), with headroom.
function stackedRangeMax(v3: number[], v2: number[], headroom = 1.1): number {
  let max = 0;
  for (let i = 0; i < v3.length; i++) {
    const sum = (v3[i] ?? 0) + (v2[i] ?? 0);
    if (sum > max) max = sum;
  }
  return max * headroom || 1;
}

// ---------------------------------------------------------------------------
// Variant A — Snap (current production)
// Plotly handles the legend click natively; autorange recomputes the range
// to fit just the visible stack. No animation, no easing.
// ---------------------------------------------------------------------------
function VariantSnap({
  data,
  v2Hidden,
}: {
  data: ReturnType<typeof buildMockData>;
  v2Hidden: boolean;
}) {
  const traces = useMemo(
    () =>
      makeTraces(data, {
        v2Visible: v2Hidden ? "legendonly" : true,
      }),
    [data, v2Hidden],
  );
  const layout = useMemo(() => makeLayout(), []);
  return (
    <Plot
      data={traces}
      layout={layout}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: "100%", height: CHART_HEIGHT }}
      useResizeHandler
    />
  );
}

// ---------------------------------------------------------------------------
// Variant B — Range-only ease (cubic-out 350ms)
// React state drives v2 visibility; layout.transition interpolates the
// y-range. Trace itself snaps (Plotly limitation on stackgroup), but the
// range glides into the new value.
// ---------------------------------------------------------------------------
function VariantRangeEase({
  data,
  v2Hidden,
}: {
  data: ReturnType<typeof buildMockData>;
  v2Hidden: boolean;
}) {
  const traces = useMemo(
    () =>
      makeTraces(data, {
        v2Visible: v2Hidden ? "legendonly" : true,
      }),
    [data, v2Hidden],
  );
  const yMax = useMemo(
    () =>
      v2Hidden
        ? stackedRangeMax(data.v3, [])
        : stackedRangeMax(data.v3, data.v2),
    [data, v2Hidden],
  );
  const layout = useMemo(
    () =>
      makeLayout({
        yRange: [0, yMax],
        transition: { duration: 350, easing: "cubic-out" as const },
      }),
    [yMax],
  );
  return (
    <Plot
      data={traces}
      layout={layout}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: "100%", height: CHART_HEIGHT }}
      useResizeHandler
    />
  );
}

// ---------------------------------------------------------------------------
// Variant C — CSS fade-out → snap → fade-in
// Wrap the chart in a div with `transition: opacity 180ms`. On toggle:
// set opacity 0, wait 180ms (fade out), flip the Plotly state under cover
// of the invisibility, set opacity 1 (fade in). Total: ~360ms.
// ---------------------------------------------------------------------------
function VariantCssFade({
  data,
  v2Hidden,
}: {
  data: ReturnType<typeof buildMockData>;
  v2Hidden: boolean;
}) {
  const [chartV2Hidden, setChartV2Hidden] = useState(v2Hidden);
  const [opacity, setOpacity] = useState(1);
  // When the parent toggles v2Hidden, fade out, swap, fade in.
  const seqRef = useRef<{ pendingHidden: boolean | null }>({
    pendingHidden: null,
  });
  useEffect(() => {
    if (chartV2Hidden === v2Hidden) return;
    seqRef.current.pendingHidden = v2Hidden;
    // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect
    setOpacity(0);
    const t1 = setTimeout(() => {
      setChartV2Hidden(seqRef.current.pendingHidden ?? false);
      setOpacity(1);
    }, 180);
    return () => clearTimeout(t1);
  }, [v2Hidden, chartV2Hidden]);

  const traces = useMemo(
    () =>
      makeTraces(data, {
        v2Visible: chartV2Hidden ? "legendonly" : true,
      }),
    [data, chartV2Hidden],
  );
  const layout = useMemo(() => makeLayout(), []);
  return (
    <div
      style={{
        opacity,
        transition: "opacity 180ms ease-in-out",
        height: CHART_HEIGHT,
      }}
    >
      <Plot
        data={traces}
        layout={layout}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: "100%", height: CHART_HEIGHT }}
        useResizeHandler
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant D — Plotly.animate explicit frames
// Use Plotly's `Plotly.animate` API to interpolate v2's y-values to zero
// over 400ms. This is the only Plotly path that ACTUALLY interpolates
// stack-trace y-values (verified in earlier instrumentation:
// `Plotly.react` snaps stacked y-arrays regardless of transition config).
// ---------------------------------------------------------------------------
function VariantPlotlyAnimate({
  data,
  v2Hidden,
}: {
  data: ReturnType<typeof buildMockData>;
  v2Hidden: boolean;
}) {
  const gdRef = useRef<HTMLElement | null>(null);
  const lastHiddenRef = useRef<boolean | null>(null);

  // Initial render uses static traces.
  const initialTraces = useMemo(() => makeTraces(data), [data]);
  const initialLayout = useMemo(
    () => makeLayout({ yRange: [0, stackedRangeMax(data.v3, data.v2)] }),
    [data],
  );

  useEffect(() => {
    if (!gdRef.current) return;
    if (lastHiddenRef.current === v2Hidden) return;
    lastHiddenRef.current = v2Hidden;
    const Plotly = (window as unknown as { Plotly?: PlotlyAPI }).Plotly;
    if (!Plotly) return;

    const targetV2Y = v2Hidden ? data.v2.map(() => 0) : data.v2;
    const targetMax = v2Hidden
      ? stackedRangeMax(data.v3, [])
      : stackedRangeMax(data.v3, data.v2);

    Plotly.animate(
      gdRef.current,
      {
        data: [
          { y: data.v3 }, // v3 unchanged
          { y: targetV2Y }, // v2 → 0 or back
        ],
        layout: { yaxis: { range: [0, targetMax] } },
        traces: [0, 1],
      },
      {
        transition: { duration: 400, easing: "cubic-out" },
        frame: { duration: 400, redraw: false },
      },
    );
  }, [v2Hidden, data]);

  return (
    <Plot
      data={initialTraces}
      layout={initialLayout}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: "100%", height: CHART_HEIGHT }}
      useResizeHandler
      onInitialized={(_fig, gd) => {
        gdRef.current = gd as unknown as HTMLElement;
      }}
    />
  );
}

interface PlotlyAPI {
  animate: (
    gd: HTMLElement,
    update: {
      data?: Array<{ y?: number[] }>;
      layout?: { yaxis?: { range?: [number, number] } };
      traces?: number[];
    },
    opts: {
      transition: { duration: number; easing: string };
      frame: { duration: number; redraw: boolean };
    },
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Variant E — Slow back-out 700ms
// Same as B (range-ease) but slower duration with an "out" curve that has
// a tiny tail bounce. To gauge whether more time on a smoother curve feels
// right, vs. the fast cubic-out.
// ---------------------------------------------------------------------------
function VariantSlowBackOut({
  data,
  v2Hidden,
}: {
  data: ReturnType<typeof buildMockData>;
  v2Hidden: boolean;
}) {
  const traces = useMemo(
    () =>
      makeTraces(data, {
        v2Visible: v2Hidden ? "legendonly" : true,
      }),
    [data, v2Hidden],
  );
  const yMax = useMemo(
    () =>
      v2Hidden
        ? stackedRangeMax(data.v3, [])
        : stackedRangeMax(data.v3, data.v2),
    [data, v2Hidden],
  );
  const layout = useMemo(
    () =>
      makeLayout({
        yRange: [0, yMax],
        transition: { duration: 700, easing: "back-out" as const },
      }),
    [yMax],
  );
  return (
    <Plot
      data={traces}
      layout={layout}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: "100%", height: CHART_HEIGHT }}
      useResizeHandler
    />
  );
}

// ---------------------------------------------------------------------------
// Variant F — Cross-fade (two charts overlaid, one shows v3+v2, the other
// v3 only; CSS-cross-fade between them on toggle).
// ---------------------------------------------------------------------------
function VariantCrossFade({
  data,
  v2Hidden,
}: {
  data: ReturnType<typeof buildMockData>;
  v2Hidden: boolean;
}) {
  const tracesAll = useMemo(() => makeTraces(data), [data]);
  const tracesV3Only = useMemo(
    () => makeTraces(data, { v2Visible: "legendonly" }),
    [data],
  );
  const yMaxAll = useMemo(() => stackedRangeMax(data.v3, data.v2), [data]);
  const yMaxV3 = useMemo(() => stackedRangeMax(data.v3, []), [data]);
  const layoutAll = useMemo(
    () => makeLayout({ yRange: [0, yMaxAll] }),
    [yMaxAll],
  );
  const layoutV3 = useMemo(() => makeLayout({ yRange: [0, yMaxV3] }), [yMaxV3]);
  return (
    <div style={{ position: "relative", height: CHART_HEIGHT }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: v2Hidden ? 0 : 1,
          transition: "opacity 280ms ease-in-out",
          pointerEvents: v2Hidden ? "none" : "auto",
        }}
      >
        <Plot
          data={tracesAll}
          layout={layoutAll}
          config={{ displayModeBar: false, responsive: true }}
          style={{ width: "100%", height: CHART_HEIGHT }}
          useResizeHandler
        />
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: v2Hidden ? 1 : 0,
          transition: "opacity 280ms ease-in-out",
          pointerEvents: v2Hidden ? "auto" : "none",
        }}
      >
        <Plot
          data={tracesV3Only}
          layout={layoutV3}
          config={{ displayModeBar: false, responsive: true }}
          style={{ width: "100%", height: CHART_HEIGHT }}
          useResizeHandler
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function VolumeAnimationsLab() {
  const data = useMemo(() => buildMockData(), []);
  const [v2Hidden, setV2Hidden] = useState(false);

  const variants = [
    {
      name: "A — Snap (current production)",
      desc: "No animation. Plotly's native legend click; autorange snaps to the new visible-only stack max.",
      Component: VariantSnap,
    },
    {
      name: "B — Range ease (cubic-out 350ms)",
      desc: "React state drives visibility. Trace snaps but `layout.transition` eases the y-range. Visible trace appears to grow as range shrinks.",
      Component: VariantRangeEase,
    },
    {
      name: "C — CSS fade out → swap → fade in (~360ms)",
      desc: "Wrapper opacity 1 → 0 (180ms), flip Plotly state under cover, opacity 0 → 1 (180ms). Hides the snap entirely.",
      Component: VariantCssFade,
    },
    {
      name: "D — Plotly.animate frames (400ms)",
      desc: "Bypasses Plotly.react. Calls Plotly.animate with explicit y-arrays + range. Should interpolate y-values too (the only path that does).",
      Component: VariantPlotlyAnimate,
    },
    {
      name: "E — Slow back-out 700ms",
      desc: "Same as B but slower with a tiny tail bounce. Gauges whether more time helps.",
      Component: VariantSlowBackOut,
    },
    {
      name: "F — Cross-fade between two charts",
      desc: "Two charts overlaid: one shows v3+v2, the other v3 only. CSS-cross-fade between them on toggle. No Plotly transitions involved.",
      Component: VariantCrossFade,
    },
  ];

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-8 text-slate-200">
      <header className="mx-auto mb-6 max-w-7xl">
        <h1 className="text-2xl font-semibold text-white">
          Volume chart — legend toggle animation lab
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          Click <strong>Toggle v2</strong> below to hide/show v2 across all
          variants simultaneously. Compare the visual feel and pick a direction.
          Toggling all together makes A/B comparison easier than per-variant
          buttons.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setV2Hidden((v) => !v)}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Toggle v2 ({v2Hidden ? "currently hidden" : "currently shown"})
          </button>
          <span className="text-xs text-slate-500">
            tip: click rapidly to stress-test interruption behavior
          </span>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 md:grid-cols-2">
        {variants.map(({ name, desc, Component }) => (
          <section
            key={name}
            className="rounded-lg border border-slate-800 bg-slate-900/60 p-5"
          >
            <h2 className="text-base font-semibold text-white">{name}</h2>
            <p className="mt-1 text-xs text-slate-400">{desc}</p>
            <div className="mt-4">
              <Component data={data} v2Hidden={v2Hidden} />
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
