"use client";

// Temporary lab page — pick an animation strategy for the volume-chart
// stacked legend toggle, then we revert this file before merge.
//
// Each variant mounts the same Plotly stacked-area chart with the same
// mock data. The "Toggle v2" button hides/shows v2 across all variants
// at once. Y-axis ticks are SHOWN here so the range animation is visible
// even though the production chart hides them. Durations are slow
// (~1500ms) so the animation behavior is unmistakable.

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

const V3_COLOR = "#6366f1";
const V2_COLOR = "#14b8a6";
const CHART_HEIGHT = 280;

// DRAMATIC data: v3 ~$100k flat, v2 ~$5M peaks. v3 is ~2% of the stacked
// max, so hiding v2 should produce a huge visual change (chart ceiling
// drops from $5M+ to $200k).
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
    // v3: 50k–150k (small, roughly flat)
    v3.push(50_000 + Math.random() * 100_000);
    // v2: 500k–4M with two big peaks
    v2.push(
      500_000 +
        Math.random() * 1_500_000 +
        (i === 5 ? 3_000_000 : 0) +
        (i === 18 ? 2_500_000 : 0),
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
    v2Visible?: boolean | "legendonly";
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
  return [v3, v2];
}

const BASE_LAYOUT = {
  paper_bgcolor: "transparent",
  plot_bgcolor: "transparent",
  font: { color: "#cbd5e1", size: 11, family: "inherit" },
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
  margin: { t: 10, r: 60, b: 50, l: 60 },
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
    transition?: { duration: number; easing: PlotlyEasing };
  } = {},
) {
  return {
    ...BASE_LAYOUT,
    yaxis: {
      // SHOW y-axis ticks here (production hides them) so the range
      // animation is visible to the human eye.
      showgrid: true,
      gridcolor: "#1e293b",
      showticklabels: true,
      tickfont: { size: 10, color: "#64748b" },
      tickformat: ".2s",
      showline: false,
      zeroline: true,
      zerolinecolor: "#334155",
      fixedrange: true,
      ...(opts.yRange
        ? { range: opts.yRange }
        : { autorange: true as const, rangemode: "tozero" as const }),
    },
    ...(opts.transition ? { transition: opts.transition } : {}),
  };
}

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
// Variant B — Range ease (cubic-out 1500ms, slow so it's obvious)
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
        transition: { duration: 1500, easing: "cubic-out" as const },
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
// Variant C — CSS fade out → snap → fade in (~600ms total)
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
    }, 300);
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
        transition: "opacity 300ms ease-in-out",
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
// Variant D — Plotly.animate frames (1200ms) — explicit y-array interpolation
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
        data: [{ y: data.v3 }, { y: targetV2Y }],
        layout: { yaxis: { range: [0, targetMax] } },
        traces: [0, 1],
      },
      {
        transition: { duration: 1200, easing: "cubic-out" },
        frame: { duration: 1200, redraw: false },
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
// Variant E — Slow back-out 2000ms with anticipation tail
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
        transition: { duration: 2000, easing: "back-out" as const },
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
// Variant F — Cross-fade between v3+v2 chart and v3-only chart (~500ms)
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
          transition: "opacity 500ms ease-in-out",
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
          transition: "opacity 500ms ease-in-out",
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
      name: "A — Snap (no animation)",
      desc: "Current production. Visibility flips instantly, autorange snaps the y-range to the new visible-only stack max.",
      Component: VariantSnap,
    },
    {
      name: "B — Range ease, cubic-out 1.5s",
      desc: "Visibility snaps but layout.transition interpolates the y-range over 1.5s. Trace shape stays the same; the y-axis ceiling visibly shrinks.",
      Component: VariantRangeEase,
    },
    {
      name: "C — CSS fade-out → swap → fade-in (~600ms)",
      desc: "Wrapper opacity 1 → 0 over 300ms, flip Plotly state under cover of invisibility, opacity 0 → 1 over 300ms. Hides the snap entirely.",
      Component: VariantCssFade,
    },
    {
      name: "D — Plotly.animate frames, 1.2s",
      desc: "Bypasses Plotly.react. Calls Plotly.animate with explicit y-arrays + range. The only path that interpolates trace y-values too.",
      Component: VariantPlotlyAnimate,
    },
    {
      name: "E — Slow back-out 2s with overshoot",
      desc: "Same shape as B but slower (2s) and with `back-out` easing (overshoots target slightly then settles). For comparison with cubic-out.",
      Component: VariantSlowBackOut,
    },
    {
      name: "F — Cross-fade between two charts (~500ms)",
      desc: "Two charts overlaid: one shows v3+v2 (its OWN y-range), the other v3-only (its own y-range). CSS-cross-fade between them. No Plotly transitions.",
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
          One <strong>Toggle v2</strong> button drives all six variants
          simultaneously. Mock data: v3 is small (~$100k flat), v2 is huge (~$5M
          peaks) — so toggling v2 produces a dramatic range change (chart
          ceiling drops from $5M+ to $200k) that&apos;s easy to see. Y-axis
          ticks are SHOWN here (production hides them) so the range animation is
          visible. Durations are slow (1.2–2s) so the behavior is unmistakable.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setV2Hidden((v) => !v)}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Toggle v2 — currently {v2Hidden ? "HIDDEN" : "SHOWN"}
          </button>
          <span className="text-xs text-slate-500">
            Click to flip across all variants. They animate in parallel so you
            can A/B compare.
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
