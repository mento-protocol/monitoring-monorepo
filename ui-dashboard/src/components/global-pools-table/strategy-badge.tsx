// Strategy badges

import type { PoolStrategyLabel } from "./formatting";

type StrategyStyle = { bg: string; text: string; ring: string };

const STRATEGY_STYLES: Record<PoolStrategyLabel, StrategyStyle> = {
  Open: {
    bg: "bg-purple-900/60",
    text: "text-purple-300",
    ring: "ring-purple-700/50",
  },
  Reserve: {
    bg: "bg-blue-900/60",
    text: "text-blue-300",
    ring: "ring-blue-700/50",
  },
  CDP: {
    bg: "bg-teal-900/60",
    text: "text-teal-300",
    ring: "ring-teal-700/50",
  },
};

export function StrategyBadge({ label }: { label: PoolStrategyLabel }) {
  const style = STRATEGY_STYLES[label];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${style.bg} ${style.text} ${style.ring}`}
    >
      {label}
    </span>
  );
}
