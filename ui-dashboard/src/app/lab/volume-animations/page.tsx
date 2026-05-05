"use client";

// Cross-fade refinements — six variants of the same "two charts overlaid,
// CSS-fade between them" pattern, tuned with different durations,
// easings, and sequencing strategies. Pick whichever feels best.

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

const V3_COLOR = "#6366f1";
const V2_COLOR = "#14b8a6";
const CHART_HEIGHT = 240;

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
    v3.push(50_000 + Math.random() * 100_000);
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
}

function makeTraces(
  data: { xs: string[]; v3: number[]; v2: number[] },
  v2Visible: boolean | "legendonly" | undefined = undefined,
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
    y: data.v2,
    name: "v2",
    type: "scatter",
    mode: "lines",
    stackgroup: "total",
    line: { color: V2_COLOR, width: 1.2 },
    fillcolor: V2_COLOR + "cc",
  };
  if (v2Visible !== undefined) v2.visible = v2Visible;
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

function makeLayout(yMax: number) {
  return {
    ...BASE_LAYOUT,
    yaxis: {
      showgrid: true,
      gridcolor: "#1e293b",
      showticklabels: true,
      tickfont: { size: 10, color: "#64748b" },
      tickformat: ".2s",
      showline: false,
      zeroline: true,
      zerolinecolor: "#334155",
      fixedrange: true,
      range: [0, yMax],
    },
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
// Generic cross-fade helper — render two overlaid Plot components, fade
// between them via CSS opacity transition with configurable
// duration/easing.
// ---------------------------------------------------------------------------
function CrossFadeChart({
  data,
  v2Hidden,
  duration,
  easing,
}: {
  data: ReturnType<typeof buildMockData>;
  v2Hidden: boolean;
  duration: number;
  easing: string;
}) {
  const tracesAll = useMemo(() => makeTraces(data), [data]);
  const tracesV3Only = useMemo(() => makeTraces(data, "legendonly"), [data]);
  const yMaxAll = useMemo(() => stackedRangeMax(data.v3, data.v2), [data]);
  const yMaxV3 = useMemo(() => stackedRangeMax(data.v3, []), [data]);
  const layoutAll = useMemo(() => makeLayout(yMaxAll), [yMaxAll]);
  const layoutV3 = useMemo(() => makeLayout(yMaxV3), [yMaxV3]);
  return (
    <div style={{ position: "relative", height: CHART_HEIGHT }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: v2Hidden ? 0 : 1,
          transition: `opacity ${duration}ms ${easing}`,
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
          transition: `opacity ${duration}ms ${easing}`,
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

// Sequential fade — first chart fades OUT fully, then second chart fades
// IN. No overlap, no concurrent rendering of both states. The user sees
// the disappearing chart fade to nothing, then the new chart materialize.
function SequentialFadeChart({
  data,
  v2Hidden,
  fadeOutMs,
  holdMs,
  fadeInMs,
}: {
  data: ReturnType<typeof buildMockData>;
  v2Hidden: boolean;
  fadeOutMs: number;
  holdMs: number;
  fadeInMs: number;
}) {
  const [phase, setPhase] = useState<"idle" | "fadeOut" | "swap" | "fadeIn">(
    "idle",
  );
  const [shownV2Hidden, setShownV2Hidden] = useState(v2Hidden);
  const lastV2HiddenRef = useRef(v2Hidden);

  useEffect(() => {
    if (lastV2HiddenRef.current === v2Hidden) return;
    lastV2HiddenRef.current = v2Hidden;
    // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect
    setPhase("fadeOut");
    const t1 = setTimeout(() => {
      setShownV2Hidden(v2Hidden);
      setPhase("swap");
    }, fadeOutMs);
    const t2 = setTimeout(() => setPhase("fadeIn"), fadeOutMs + holdMs);
    const t3 = setTimeout(
      () => setPhase("idle"),
      fadeOutMs + holdMs + fadeInMs,
    );
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [v2Hidden, fadeOutMs, holdMs, fadeInMs]);

  const tracesAll = useMemo(() => makeTraces(data), [data]);
  const tracesV3 = useMemo(() => makeTraces(data, "legendonly"), [data]);
  const yMaxAll = useMemo(() => stackedRangeMax(data.v3, data.v2), [data]);
  const yMaxV3 = useMemo(() => stackedRangeMax(data.v3, []), [data]);
  const layoutAll = useMemo(() => makeLayout(yMaxAll), [yMaxAll]);
  const layoutV3 = useMemo(() => makeLayout(yMaxV3), [yMaxV3]);

  // Decide opacity + which chart to show this frame
  const useV3Only = shownV2Hidden;
  let opacity = 1;
  let transitionMs = 0;
  if (phase === "fadeOut") {
    opacity = 0;
    transitionMs = fadeOutMs;
  } else if (phase === "swap") {
    opacity = 0;
    transitionMs = 0;
  } else if (phase === "fadeIn") {
    opacity = 1;
    transitionMs = fadeInMs;
  }

  return (
    <div
      style={{
        opacity,
        transition: `opacity ${transitionMs}ms ease-in-out`,
        height: CHART_HEIGHT,
      }}
    >
      <Plot
        data={useV3Only ? tracesV3 : tracesAll}
        layout={useV3Only ? layoutV3 : layoutAll}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: "100%", height: CHART_HEIGHT }}
        useResizeHandler
      />
    </div>
  );
}

type VariantProps = {
  data: ReturnType<typeof buildMockData>;
  v2Hidden: boolean;
};

function VariantF1(props: VariantProps) {
  return <CrossFadeChart {...props} duration={250} easing="ease-out" />;
}
function VariantF2(props: VariantProps) {
  return <CrossFadeChart {...props} duration={500} easing="ease-in-out" />;
}
function VariantF3(props: VariantProps) {
  return <CrossFadeChart {...props} duration={800} easing="ease-in-out" />;
}
function VariantF4(props: VariantProps) {
  return (
    <CrossFadeChart
      {...props}
      duration={400}
      easing="cubic-bezier(0.4, 0, 0.2, 1)"
    />
  );
}
function VariantF5(props: VariantProps) {
  return (
    <SequentialFadeChart
      {...props}
      fadeOutMs={350}
      holdMs={50}
      fadeInMs={350}
    />
  );
}
function VariantF6(props: VariantProps) {
  return (
    <SequentialFadeChart
      {...props}
      fadeOutMs={200}
      holdMs={20}
      fadeInMs={200}
    />
  );
}

export default function VolumeAnimationsLab() {
  const data = useMemo(() => buildMockData(), []);
  const [v2Hidden, setV2Hidden] = useState(false);

  const variants = [
    {
      name: "F1 — Cross-fade 250ms ease-out",
      desc: "Snappy, fast cross-fade. Two charts overlap during the transition.",
      Component: VariantF1,
    },
    {
      name: "F2 — Cross-fade 500ms ease-in-out",
      desc: "Mid-speed cross-fade. The default cross-fade you saw before.",
      Component: VariantF2,
    },
    {
      name: "F3 — Cross-fade 800ms ease-in-out",
      desc: "Slower, more graceful. Lets you see both states overlap longer.",
      Component: VariantF3,
    },
    {
      name: "F4 — Cross-fade 400ms with Material curve",
      desc: "400ms cubic-bezier(0.4, 0, 0.2, 1) — Material Design's 'standard' easing. Feels more deliberate than a stock ease-in-out.",
      Component: VariantF4,
    },
    {
      name: "F5 — Sequential fade-out → swap → fade-in (350ms each)",
      desc: "The OLD chart fades to invisible, then the NEW chart fades in. No overlap, no two-states-on-screen-at-once. ~700ms total.",
      Component: VariantF5,
    },
    {
      name: "F6 — Sequential 200ms each (snappier)",
      desc: "Same as F5 but fast: fade out 200ms, fade in 200ms. ~400ms total.",
      Component: VariantF6,
    },
  ];

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-8 text-slate-200">
      <header className="mx-auto mb-6 max-w-7xl">
        <h1 className="text-2xl font-semibold text-white">
          Cross-fade refinements
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          Six cross-fade variations. F1–F4 are simultaneous cross-fades (two
          charts overlaid, opacity flips between them) at different durations /
          easings. F5–F6 are SEQUENTIAL fades (old fades out completely, then
          new fades in — no overlap). Click toggle to see all six animate in
          parallel.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setV2Hidden((v) => !v)}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Toggle v2 — currently {v2Hidden ? "HIDDEN" : "SHOWN"}
          </button>
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
