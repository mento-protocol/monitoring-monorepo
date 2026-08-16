"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { Provider as TooltipProvider } from "@radix-ui/react-tooltip";
import { ErrorBox } from "@/components/feedback";
import { usePegAlerts } from "@/hooks/use-peg-alerts";
import { usePegMonitoring } from "@/hooks/use-peg-monitoring";
import { classifyPegMonitoringState } from "@/lib/peg-monitoring";
import { presentPegMonitoring } from "@/lib/peg-monitoring-presentation";
import { BoardHeader } from "./_components/board-header";
import { BoardTable } from "./_components/board-table";
import { RecentAlerts } from "./_components/recent-alerts";
import { formatAge } from "./_lib/peg-board-format";
import { PEG_BOARD_VARS } from "./_lib/peg-board-model";
import { PegMonitoringLoading } from "./peg-monitoring-loading";

/**
 * The board opts into the Mento design system locally: `dark` activates the
 * package's token block, AspektaVF comes from `theme.css`'s `@font-face`, and
 * the custom properties cover the mockup colours the token set has no name for.
 * Scoping it here keeps every other route on the app's Geist/slate look.
 */
const boardStyle: CSSProperties = {
  fontFamily: '"AspektaVF", var(--font-geist-sans), sans-serif',
  ...PEG_BOARD_VARS,
};

const AGE_TICK_MS = 10_000;

export function PegMonitoringPageClient(): React.JSX.Element {
  const result = usePegMonitoring();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  const nowMs = Math.max(now, Date.now());
  const state = classifyPegMonitoringState({ ...result, nowMs });
  const confirmed = state.kind === "current" || state.kind === "stale";
  const alerts = usePegAlerts(confirmed);
  const usesPreviousPolicy =
    confirmed &&
    (state.data.policySlot === "previous" ||
      state.data.producedPolicyVersion !==
        state.data.approvedActivePolicyVersion);
  const presentation = confirmed
    ? presentPegMonitoring(state.data, {
        nowMs,
        packageIsStale: state.kind === "stale",
        usesPreviousPolicy,
      })
    : null;
  return (
    <TooltipProvider delayDuration={120}>
      <main
        data-testid="peg-monitoring-page"
        className="dark bg-background p-4 text-foreground sm:p-7"
        style={boardStyle}
      >
        {state.kind === "loading" ? (
          <PegMonitoringLoading />
        ) : state.kind === "unavailable" || presentation === null ? (
          <ErrorBox message="Peg monitoring is unavailable. No confirmed decision package can be shown." />
        ) : (
          <>
            <BoardHeader presentation={presentation} />
            <BoardTable
              presentation={presentation}
              nowMs={nowMs}
              producedAt={state.data.producedAt}
              stale={state.kind === "stale"}
              previousPolicy={usesPreviousPolicy}
              ageLabel={formatAge(state.ageMs)}
              policyVersion={state.data.producedPolicyVersion}
            />
            <RecentAlerts
              events={alerts.data?.events ?? []}
              monitoring={state.data}
              nowMs={nowMs}
              state={
                alerts.hasError
                  ? "unavailable"
                  : alerts.data !== null
                    ? "ready"
                    : alerts.isLoading
                      ? "loading"
                      : "unavailable"
              }
            />
          </>
        )}
      </main>
    </TooltipProvider>
  );
}
