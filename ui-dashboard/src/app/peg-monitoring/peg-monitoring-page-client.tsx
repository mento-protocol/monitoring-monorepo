"use client";

import { useEffect, useState } from "react";
import { ErrorBox } from "@/components/feedback";
import { usePegMonitoring } from "@/hooks/use-peg-monitoring";
import { classifyPegMonitoringState } from "@/lib/peg-monitoring";
import { presentPegMonitoring } from "@/lib/peg-monitoring-presentation";
import { PegMonitoringEvidence } from "./peg-monitoring-evidence";
import { PegMonitoringLoading } from "./peg-monitoring-loading";
import { PegMonitoringScorecard } from "./peg-monitoring-scorecard";

function Header(): React.JSX.Element {
  return (
    <header className="space-y-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-400">
          Peg monitoring
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
          Peg status
        </h1>
      </div>
      <p className="max-w-3xl text-sm leading-6 text-slate-400">
        See whether a monitored asset is off peg or nearing a warning threshold
        from its current measurement and supporting evidence.
      </p>
    </header>
  );
}

export function PegMonitoringPageClient(): React.JSX.Element {
  const result = usePegMonitoring();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const nowMs = Math.max(now, Date.now());
  const state = classifyPegMonitoringState({
    ...result,
    nowMs,
  });
  const usesPreviousPolicy =
    (state.kind === "current" || state.kind === "stale") &&
    (state.data.policySlot === "previous" ||
      state.data.producedPolicyVersion !==
        state.data.approvedActivePolicyVersion);
  const presentation =
    state.kind === "current" || state.kind === "stale"
      ? presentPegMonitoring(state.data, {
          nowMs,
          packageIsStale: state.kind === "stale",
          usesPreviousPolicy,
        })
      : null;
  return (
    <main data-testid="peg-monitoring-page" className="space-y-8">
      <Header />
      {state.kind === "loading" ? (
        <PegMonitoringLoading />
      ) : state.kind === "unavailable" ? (
        <ErrorBox message="Peg monitoring is unavailable. No confirmed decision package can be shown." />
      ) : (
        <div className="space-y-6">
          <PegMonitoringScorecard
            presentation={presentation!}
            ageMs={state.ageMs}
            stale={state.kind === "stale"}
            usesPreviousPolicy={usesPreviousPolicy}
          />
          <PegMonitoringEvidence
            state={state}
            presentation={presentation!}
            nowMs={nowMs}
          />
        </div>
      )}
    </main>
  );
}
