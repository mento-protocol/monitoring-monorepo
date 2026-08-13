import { PEG_BOARD_GRID, PEG_BOARD_MIN_WIDTH } from "./_lib/peg-board-model";

const rows = ["first", "second"];
const cells = [
  ["peg", "w-20"],
  ["status", "w-16"],
  ["price", "w-14"],
  ["distance", "w-full"],
  ["market", "w-28"],
  ["spread", "w-12"],
  ["limit", "w-10"],
  ["breaker", "w-14"],
  ["chevron", "w-7"],
] as const;

function Bar({ className }: { className: string }): React.JSX.Element {
  return (
    <div className={`h-3 bg-[oklch(26.13%_0.0288_302.75)] ${className}`} />
  );
}

/**
 * Board-shaped skeleton: same header row, same nine-column grid and the same
 * 16px row padding as the loaded table, so the first paint does not reflow.
 */
export function PegMonitoringLoading(): React.JSX.Element {
  return (
    <div aria-label="Loading peg monitoring" className="animate-pulse">
      <div
        data-testid="peg-skeleton-header"
        className="mb-[22px] flex items-center justify-between gap-3"
      >
        <div className="flex items-center gap-3">
          <Bar className="h-6 w-44" />
          <Bar className="h-6 w-52" />
        </div>
        <Bar className="w-32" />
      </div>
      <div data-testid="peg-skeleton-board" className="border border-border">
        <div className="overflow-x-auto">
          <div className={PEG_BOARD_MIN_WIDTH}>
            <div
              className={`grid border-b border-border px-[18px] py-2.5 ${PEG_BOARD_GRID}`}
            >
              {cells.map(([column, width]) => (
                <Bar key={column} className={`h-2.5 ${width}`} />
              ))}
            </div>
            {rows.map((row) => (
              <div
                key={row}
                className={`grid items-center border-b border-border px-[18px] py-4 ${PEG_BOARD_GRID}`}
              >
                {cells.map(([column, width]) => (
                  <Bar key={column} className={`h-5 ${width}`} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div
        data-testid="peg-skeleton-alerts"
        className="mt-3.5 border border-border px-[18px] py-3"
      >
        <Bar className="w-40" />
      </div>
    </div>
  );
}
