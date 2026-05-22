// ---------------------------------------------------------------------------
// Token color palette for the /stables page.
//
// Brand-derived Tailwind 400-tier picks balanced against the slate-900/60
// card background used by TimeSeriesChartCard. USDm gets emerald (the
// "supply growth = green" intuition for the USD anchor). Flag-color
// associations for CHFm/JPYm where they read distinctly. The hash fallback
// keeps any future token off-collision until a curated color lands.
//
// Why hex strings (not Tailwind class names): Plotly traces consume CSS
// colors directly, and `TimeSeriesChartCard.BreakdownSeries.color` (see
// `src/components/time-series-chart-card.tsx:246`) appends "cc" for an
// alpha-blended fill — that string concatenation requires a 6-digit hex
// literal, not a Tailwind class.
// ---------------------------------------------------------------------------

const PALETTE: Record<string, string> = {
  // Reserve-backed (V2) + V3 hub stables.
  USDm: "#34d399", // emerald-400 — USD anchor / "expansion green"
  EURm: "#60a5fa", // blue-400 — EU
  BRLm: "#a78bfa", // violet-400 — BR
  AUDm: "#fbbf24", // amber-400 — AU
  CADm: "#f472b6", // pink-400 — CA
  COPm: "#fb923c", // orange-400 — CO
  GHSm: "#facc15", // yellow-400 — GH
  KESm: "#22d3ee", // cyan-400 — KE
  NGNm: "#a3e635", // lime-400 — NG
  PHPm: "#fda4af", // rose-300 — PH
  XOFm: "#c4b5fd", // violet-300 — XOF (West African franc)
  ZARm: "#bef264", // lime-300 — ZA
  // V3 Liquity debt (CDP-issued).
  GBPm: "#f87171", // red-400 — UK / Liquity accent
  CHFm: "#fb7185", // rose-400 — CH (matches flag)
  JPYm: "#fde047", // yellow-300 — JP (matches flag)
};

// Stable-but-not-curated palette for any future symbol not in PALETTE.
// Chosen so two new tokens don't land on the same hex by accident.
const FALLBACK = [
  "#67e8f9",
  "#5eead4",
  "#86efac",
  "#fcd34d",
  "#fdba74",
  "#f9a8d4",
  "#d8b4fe",
  "#a5b4fc",
  "#7dd3fc",
  "#94a3b8",
];

/**
 * Returns a 6-digit hex color for a token symbol. Curated picks for known
 * Mento stables; deterministic hash fallback for anything else. Stable
 * identity per symbol — calling with "USDm" always returns the same color.
 */
export function tokenColor(symbol: string): string {
  const hit = PALETTE[symbol];
  if (hit) return hit;
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) {
    hash = (hash * 31 + symbol.charCodeAt(i)) | 0;
  }
  return FALLBACK[Math.abs(hash) % FALLBACK.length];
}
