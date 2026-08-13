"use client";

import type { CSSProperties } from "react";
import type { PegMonitoringPresentation } from "@/lib/peg-monitoring-presentation";
import {
  PEG_COLOR,
  boardSummary,
  headerAlertRules,
  type PegBoardTone,
} from "../_lib/peg-board-model";
import { InfoDot, SeverityDot } from "./board-primitives";

const pillTint: Record<PegBoardTone, CSSProperties> = {
  healthy: {
    color: PEG_COLOR.green,
    backgroundColor: "oklch(73.5% 0.245 142 / 0.12)",
    borderColor: "oklch(73.5% 0.245 142 / 0.35)",
  },
  warning: {
    color: PEG_COLOR.amber,
    backgroundColor: "oklch(76.9% 0.188 70 / 0.12)",
    borderColor: "oklch(76.9% 0.188 70 / 0.35)",
  },
  uncertain: {
    color: PEG_COLOR.amber,
    backgroundColor: "oklch(76.9% 0.188 70 / 0.12)",
    borderColor: "oklch(76.9% 0.188 70 / 0.35)",
  },
  critical: {
    color: PEG_COLOR.redText,
    backgroundColor: "oklch(54.7% 0.193 26.4 / 0.16)",
    borderColor: "oklch(54.7% 0.193 26.4 / 0.45)",
  },
};

/**
 * The board states its verdict once: a pill here, a badge per row. The alert
 * rules that used to occupy three cards now live behind the ⓘ, interpolated
 * from the package's own policy.
 */
export function BoardHeader({
  presentation,
}: {
  presentation: PegMonitoringPresentation;
}): React.JSX.Element {
  const summary = boardSummary(presentation);
  const alertRules = headerAlertRules(presentation);
  return (
    <header className="mb-[22px] flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[22px] font-[640] tracking-[-0.01em] text-foreground">
          Peg Monitoring
        </h1>
        <span
          data-testid="peg-aggregate-status"
          role="status"
          aria-label={summary.ariaLabel}
          className="inline-flex items-center gap-1.5 border px-2.5 py-1 text-[12px] font-[650]"
          style={pillTint[summary.tone]}
        >
          <SeverityDot tone={summary.tone} size={7} />
          {summary.text}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-muted-foreground">
          {alertRules.cadence}
        </span>
        {alertRules.rules.length === 0 ? null : (
          <InfoDot
            label={alertRules.tooltipLabel}
            content={
              alertRules.rules.length === 1 &&
              alertRules.rules[0]!.label === null ? (
                alertRules.rules[0]!.text
              ) : (
                <span className="grid gap-2">
                  {alertRules.rules.map((rule) => (
                    <span key={rule.label ?? "shared"}>
                      <strong className="font-[650]">{rule.label}</strong> —{" "}
                      {rule.text}
                    </span>
                  ))}
                </span>
              )
            }
          />
        )}
      </div>
    </header>
  );
}
