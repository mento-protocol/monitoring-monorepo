/**
 * Shared Plotly layout defaults for the dashboard's dark-theme charts.
 * Import and spread into chart-specific layouts to reduce duplication.
 */

/** Plot / content area height for the standard row-embedded chart cards
 *  (TimeSeriesChartCard, and the bridge-flows sibling cards that sit in the
 *  same row). Centralized so tweaking one card doesn't silently desync
 *  neighbours in the same grid row. */
export const ROW_CHART_HEIGHT_PX = 200;

/** Axis styling shared across all charts. */
export const PLOTLY_AXIS_DEFAULTS = {
  gridcolor: "#1e293b",
  linecolor: "#334155",
  tickcolor: "#334155",
} as const;

/** Canvas / paper background and font shared across all charts. */
export const PLOTLY_BASE_LAYOUT = {
  paper_bgcolor: "transparent",
  plot_bgcolor: "transparent",
  font: { color: "#94a3b8", size: 12 },
} as const;

/** Range-selector button presets for time-series charts. */
export const RANGE_SELECTOR_BUTTONS_DAILY = [
  {
    count: 1,
    label: "1d",
    step: "day" as const,
    stepmode: "backward" as const,
  },
  {
    count: 7,
    label: "7d",
    step: "day" as const,
    stepmode: "backward" as const,
  },
  {
    count: 30,
    label: "30d",
    step: "day" as const,
    stepmode: "backward" as const,
  },
  { step: "all" as const, label: "All" },
];

export const RANGE_SELECTOR_BUTTONS_HOURLY = [
  {
    count: 1,
    label: "1h",
    step: "hour" as const,
    stepmode: "backward" as const,
  },
  {
    count: 6,
    label: "6h",
    step: "hour" as const,
    stepmode: "backward" as const,
  },
  {
    count: 1,
    label: "1d",
    step: "day" as const,
    stepmode: "backward" as const,
  },
  {
    count: 7,
    label: "7d",
    step: "day" as const,
    stepmode: "backward" as const,
  },
  { step: "all" as const, label: "All" },
];

/** Range-selector / range-slider common styling. */
const PLOTLY_RANGE_SELECTOR_STYLE = {
  bgcolor: "#1e293b",
  activecolor: "#334155",
  bordercolor: "#475569",
  borderwidth: 1,
  font: { color: "#94a3b8" },
} as const;

const PLOTLY_RANGE_SLIDER_STYLE = {
  bgcolor: "#1e293b",
  bordercolor: "#334155",
  thickness: 0.08,
} as const;

type RangeSelectorButton =
  | {
      count: number;
      label: string;
      step: "hour" | "day" | "month" | "year";
      stepmode: "backward";
    }
  | { step: "all"; label: string; count?: undefined; stepmode?: undefined };

/** Common xaxis config for date-typed, sliding time-series charts. */
export function makeDateXAxis(
  buttons: RangeSelectorButton[],
): Record<string, unknown> {
  return {
    ...PLOTLY_AXIS_DEFAULTS,
    type: "date",
    rangeslider: PLOTLY_RANGE_SLIDER_STYLE,
    rangeselector: { ...PLOTLY_RANGE_SELECTOR_STYLE, buttons },
  };
}

/** Standard legend styling. */
export const PLOTLY_LEGEND = {
  bgcolor: "transparent",
  bordercolor: "#334155",
  borderwidth: 1,
} as const;

/** Standard Plotly config (no mode bar, responsive, pan on drag). */
export const PLOTLY_CONFIG = {
  responsive: true,
  displayModeBar: false,
  scrollZoom: true,
} as const;

/**
 * HTML-escape a string before it reaches Plotly's `labels`, `text`, or
 * `%{...}` hovertemplate slots. Plotly renders a permissive subset of HTML
 * in these fields (that's why `<b>Bold</b>` works), so any user-controlled
 * string interpolated there is an XSS sink — a label like
 * `<img src=x onerror=alert(1)>` would execute when the legend renders or
 * a slice is hovered. Escape at the render boundary; keep stored values raw.
 */
export function escapePlotText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
