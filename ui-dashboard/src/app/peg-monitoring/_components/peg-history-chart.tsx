"use client";

import { useState } from "react";
import type { PegAssetPackage } from "@/lib/peg-monitoring";
import {
  PEG_CHART,
  PEG_CHART_DEFAULT_RANGE,
  PEG_CHART_RANGES,
  nearestPointIndex,
  pegChartBands,
  pegChartScale,
  pointXAt,
  type PegChartRange,
  type PegHistoryPoint,
} from "../_lib/peg-chart-scale";
import {
  PEG_COLOR,
  PEG_TONE_COLOR,
  formatDeviationBps,
  type PegBoardTone,
} from "../_lib/peg-board-model";

const dayTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});
const day = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** "3.1 bps below target" / "at target" — matches the row's zero handling. */
function deviationPhrase(bps: number): string {
  if (bps === 0) return "at target";
  return `${formatDeviationBps(Math.abs(bps))} ${bps < 0 ? "below" : "above"} target`;
}

function pointLabel(point: PegHistoryPoint): string {
  const stamp = dayTime.format(point.at * 1_000).replace(",", "");
  return `${stamp} · ${deviationPhrase(point.bps)}${point.event === undefined ? "" : ` · ${point.event}`}`;
}

const RANGE_MS: Record<PegChartRange, number> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

type ChartProps = {
  policy: PegAssetPackage["policy"];
  /** Signed current deviation; negative is below target. */
  nowBps: number | null;
  tone: PegBoardTone;
  measurement: string;
  nowMs: number;
  series?: readonly PegHistoryPoint[] | undefined;
};

export function PegHistoryChart({
  policy,
  nowBps,
  tone,
  measurement,
  nowMs,
  series,
}: ChartProps): React.JSX.Element {
  const [range, setRange] = useState<PegChartRange>(PEG_CHART_DEFAULT_RANGE);
  const [hovered, setHovered] = useState<number | null>(null);
  // The selected range is a promise to the reader: whatever the feed supplies,
  // only readings inside the window may plot, feed the axis, or reach the
  // hover/reading list.
  const cutoffSeconds = (nowMs - RANGE_MS[range]) / 1_000;
  const points = (series ?? []).filter((point) => point.at >= cutoffSeconds);
  // Timestamp-derived x positions: a gap between polls occupies its real
  // share of the window instead of collapsing to one array step.
  const pointXs = points.map((point) =>
    pointXAt(point.at, cutoffSeconds, nowMs / 1_000),
  );
  const scale = pegChartScale(policy);
  const nowY = nowBps === null ? null : scale.y(nowBps);

  return (
    <figure className="m-0">
      <ChartHeader measurement={measurement} range={range} onRange={setRange} />
      <div
        onPointerMove={(event) => {
          if (points.length === 0) return;
          const box = event.currentTarget.getBoundingClientRect();
          const x =
            ((event.clientX - box.left) / box.width) * PEG_CHART.viewBoxWidth;
          setHovered(nearestPointIndex(x, pointXs));
        }}
        onPointerLeave={() => setHovered(null)}
      >
        <svg
          viewBox={`0 0 ${PEG_CHART.viewBoxWidth} ${PEG_CHART.viewBoxHeight}`}
          role="img"
          aria-label={chartLabel(nowBps, range, points.length)}
          className="block w-full"
        >
          <ChartBands policy={policy} />
          <ChartSeries points={points} xs={pointXs} scale={scale} tone={tone} />
          <ChartGutter
            policy={policy}
            nowBps={nowBps}
            nowY={nowY}
            tone={tone}
          />
          {points.length === 0 ? (
            <text
              x={PEG_CHART.plotWidth / 2}
              y={scale.y(0) - 12}
              textAnchor="middle"
              fontSize={12}
              fill={PEG_COLOR.muted}
            >
              History unavailable
            </text>
          ) : (
            <ChartAxis points={points} xs={pointXs} />
          )}
          {hovered === null ||
          points[hovered] === undefined ||
          pointXs[hovered] === undefined ? null : (
            <HoverCallout
              point={points[hovered]}
              x={pointXs[hovered]}
              scale={scale}
            />
          )}
        </svg>
      </div>
      {points.length === 0 ? null : (
        <ul className="sr-only">
          {points.map((point) => (
            <li key={point.at}>{pointLabel(point)}</li>
          ))}
        </ul>
      )}
    </figure>
  );
}

function ChartHeader({
  measurement,
  range,
  onRange,
}: {
  measurement: string;
  range: PegChartRange;
  onRange: (range: PegChartRange) => void;
}): React.JSX.Element {
  return (
    <figcaption className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="text-[13px] font-[650] text-foreground">
          Peg History
        </span>
        <span className="ml-2 text-[12px] text-muted-foreground">
          · Primary Market · {measurement}
        </span>
      </span>
      <span className="flex shrink-0 gap-1.5">
        {PEG_CHART_RANGES.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === range}
            onClick={() => onRange(option)}
            className={`border px-[9px] py-[2px] text-[10.5px] ${
              option === range
                ? "border-[var(--border-secondary)] font-[650] text-foreground"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {option}
          </button>
        ))}
      </span>
    </figcaption>
  );
}

function chartLabel(
  nowBps: number | null,
  range: PegChartRange,
  count: number,
): string {
  const current =
    nowBps === null
      ? "the current deviation is unavailable"
      : `now ${deviationPhrase(nowBps)}`;
  return count === 0
    ? `Peg history over ${range}. History is unavailable, so only the alert bands and ${current} are drawn.`
    : `Peg history over ${range}: ${count} readings, ${current}.`;
}

function ChartBands({
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

function ChartSeries({
  points,
  xs,
  scale,
  tone,
}: {
  points: readonly PegHistoryPoint[];
  xs: readonly number[];
  scale: ReturnType<typeof pegChartScale>;
  tone: PegBoardTone;
}): React.JSX.Element | null {
  if (points.length === 0) return null;
  const path = points
    .map((point, index) => `${xs[index]!},${scale.y(point.bps)}`)
    .join(" ");
  return (
    <polyline
      points={path}
      fill="none"
      stroke={PEG_TONE_COLOR[tone]}
      strokeWidth={2}
      strokeLinejoin="round"
    />
  );
}

function ChartAxis({
  points,
  xs,
}: {
  points: readonly PegHistoryPoint[];
  xs: readonly number[];
}): React.JSX.Element {
  const ticks = [0, 0.33, 0.66, 1].map((ratio) => {
    const index = Math.min(
      points.length - 1,
      Math.round(ratio * (points.length - 1)),
    );
    return { index, x: xs[index]! };
  });
  return (
    <g>
      {ticks.map((tick) => (
        <text
          key={tick.index}
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

function ChartGutter({
  policy,
  nowBps,
  nowY,
  tone,
}: {
  policy: PegAssetPackage["policy"];
  nowBps: number | null;
  nowY: number | null;
  tone: PegBoardTone;
}): React.JSX.Element {
  const scale = pegChartScale(policy);
  const bands = pegChartBands(scale);
  const targetY = scale.y(0);
  const nowLabelY =
    nowY === null
      ? null
      : Math.abs(nowY - targetY) < 12
        ? targetY + 14
        : nowY + 3.5;
  return (
    <g>
      {bands.map((band) => (
        <rect
          key={band.key}
          x={PEG_CHART.railX}
          y={band.y}
          width={PEG_CHART.railWidth}
          height={band.height}
          fill={band.railFill}
        />
      ))}
      <line
        x1={PEG_CHART.railX - 2}
        x2={PEG_CHART.railX + PEG_CHART.railWidth + 2}
        y1={targetY}
        y2={targetY}
        stroke="oklch(98% 0.0054 297.73 / 0.7)"
        strokeWidth={1.5}
      />
      {nowY === null ? null : (
        <circle
          cx={PEG_CHART.railX + PEG_CHART.railWidth / 2}
          cy={nowY}
          r={6}
          fill={PEG_TONE_COLOR[tone]}
          stroke={PEG_COLOR.background}
          strokeWidth={2}
        />
      )}
      <text
        x={PEG_CHART.labelX}
        y={scale.y(scale.premiumWarnBps) + 3}
        fontSize={10}
        fill={PEG_COLOR.amber}
      >
        +{scale.premiumWarnBps} bps
      </text>
      <text
        x={PEG_CHART.labelX}
        y={targetY - 3}
        fontSize={10}
        fill={PEG_COLOR.muted}
      >
        target {policy.target.toFixed(4)}
      </text>
      {nowBps === null || nowLabelY === null ? null : (
        <text
          x={PEG_CHART.labelX}
          y={nowLabelY}
          fontSize={10}
          fill={PEG_TONE_COLOR[tone]}
        >
          {nowBps === 0
            ? "now 0 bps"
            : `now ${nowBps < 0 ? "−" : "+"}${formatDeviationBps(Math.abs(nowBps))}`}
        </text>
      )}
      <text
        x={PEG_CHART.labelX}
        y={scale.y(-scale.warnBps) + 3}
        fontSize={10}
        fill={PEG_COLOR.amber}
      >
        −{scale.warnBps} bps
      </text>
      <text
        x={PEG_CHART.labelX}
        y={scale.y(-scale.criticalBps) + 3}
        fontSize={10}
        fill={PEG_COLOR.redText}
      >
        −{scale.criticalBps} bps
      </text>
    </g>
  );
}

function HoverCallout({
  point,
  x,
  scale,
}: {
  point: PegHistoryPoint;
  x: number;
  scale: ReturnType<typeof pegChartScale>;
}): React.JSX.Element {
  const label = pointLabel(point);
  const width = Math.min(320, Math.max(180, label.length * 6.1));
  const boxX = Math.min(
    PEG_CHART.plotWidth - width,
    Math.max(0, x - width / 2),
  );
  const y = scale.y(point.bps);
  const boxY = Math.max(2, y - 44);
  return (
    <g>
      <line
        x1={x}
        x2={x}
        y1={boxY + 24}
        y2={y}
        stroke={PEG_COLOR.borderStrong}
        strokeWidth={1}
        strokeDasharray="3 3"
      />
      <rect
        x={boxX}
        y={boxY}
        width={width}
        height={24}
        fill={PEG_COLOR.surface}
        stroke={PEG_COLOR.borderStrong}
        strokeWidth={1}
      />
      <text
        x={boxX + width / 2}
        y={boxY + 16}
        textAnchor="middle"
        fontSize={11}
        fill={PEG_COLOR.text2}
      >
        {label}
      </text>
      <circle cx={x} cy={y} r={3.5} fill={PEG_COLOR.amber} />
    </g>
  );
}
