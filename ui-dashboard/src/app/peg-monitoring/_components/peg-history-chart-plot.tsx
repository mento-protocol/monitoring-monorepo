import type { PegAssetPackage } from "@/lib/peg-monitoring";
import {
  PEG_CHART,
  pegChartBands,
  pegChartScale,
  type PegHistoryPoint,
} from "../_lib/peg-chart-scale";
import {
  PEG_COLOR,
  PEG_TONE_COLOR,
  type PegBoardTone,
} from "../_lib/peg-board-model";

const day = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function ChartBands({
  policy,
}: {
  policy: PegAssetPackage["policy"];
}): React.JSX.Element {
  const scale = pegChartScale(policy);
  const bands = pegChartBands(scale);
  const lines: Array<{ y: number; stroke: string }> = [
    { y: scale.y(scale.premiumWarnBps), stroke: "oklch(76.9% 0.188 70 / 0.5)" },
    { y: scale.y(-scale.warnBps), stroke: "oklch(76.9% 0.188 70 / 0.5)" },
    { y: scale.y(-scale.criticalBps), stroke: "oklch(54.7% 0.193 26.4 / 0.6)" },
  ];
  return (
    <g>
      {bands.map((band) => (
        <rect
          key={band.key}
          x={0}
          y={band.y}
          width={PEG_CHART.plotWidth}
          height={band.height}
          fill={band.fill}
        />
      ))}
      {lines.map((line) => (
        <line
          key={line.y}
          x1={0}
          x2={PEG_CHART.plotWidth}
          y1={line.y}
          y2={line.y}
          stroke={line.stroke}
          strokeWidth={1}
          strokeDasharray="4 4"
        />
      ))}
      <line
        x1={0}
        x2={PEG_CHART.plotWidth}
        y1={scale.y(0)}
        y2={scale.y(0)}
        stroke="oklch(98% 0.0054 297.73 / 0.3)"
        strokeWidth={1}
      />
    </g>
  );
}

export function ChartSeries({
  points,
  xs,
  stepSeconds,
  scale,
  tone,
}: {
  points: readonly PegHistoryPoint[];
  xs: readonly number[];
  stepSeconds: number;
  scale: ReturnType<typeof pegChartScale>;
  tone: PegBoardTone;
}): React.JSX.Element | null {
  if (points.length === 0) return null;
  const segments: Array<Array<{ point: PegHistoryPoint; x: number }>> = [];
  points.forEach((point, index) => {
    const previous = points[index - 1];
    if (previous === undefined || point.at - previous.at > stepSeconds * 1.5)
      segments.push([]);
    segments.at(-1)!.push({ point, x: xs[index]! });
  });
  return (
    <g>
      {segments.map((segment) =>
        segment.length === 1 ? (
          <circle
            key={segment[0]!.point.at}
            data-testid={
              points.length === 1
                ? "peg-history-single-point"
                : "peg-history-isolated-point"
            }
            cx={segment[0]!.x}
            cy={scale.y(segment[0]!.point.bps)}
            r={3.5}
            fill={PEG_TONE_COLOR[tone]}
          />
        ) : (
          <polyline
            key={segment[0]!.point.at}
            data-testid="peg-history-line-segment"
            points={segment
              .map(({ point, x }) => `${x},${scale.y(point.bps)}`)
              .join(" ")}
            fill="none"
            stroke={PEG_TONE_COLOR[tone]}
            strokeWidth={2}
            strokeLinejoin="round"
          />
        ),
      )}
    </g>
  );
}

export function ChartAxis({
  points,
  xs,
}: {
  points: readonly PegHistoryPoint[];
  xs: readonly number[];
}): React.JSX.Element {
  const ratios = points.length === 1 ? [0] : [0, 0.33, 0.66, 1];
  const ticks = ratios.map((ratio) => {
    const index = Math.min(
      points.length - 1,
      Math.round(ratio * (points.length - 1)),
    );
    return { index, ratio, x: xs[index]! };
  });
  return (
    <g>
      {ticks.map((tick) => (
        <text
          key={tick.ratio}
          data-testid="peg-history-axis-tick"
          x={Math.min(PEG_CHART.plotWidth - 12, Math.max(12, tick.x))}
          y={PEG_CHART.axisY}
          textAnchor="middle"
          fontSize={10}
          fill={PEG_COLOR.muted}
        >
          {day.format(points[tick.index]!.at * 1_000)}
        </text>
      ))}
    </g>
  );
}
