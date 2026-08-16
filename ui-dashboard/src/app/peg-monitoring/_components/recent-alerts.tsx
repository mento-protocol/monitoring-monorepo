"use client";

import { PEG_GRAFANA_ALERTS_URL } from "@/lib/peg-monitoring";
import type { PegMonitoringResponse } from "@/lib/peg-monitoring";
import type { PegAlertEvent, PegAlertSeverity } from "@/lib/peg-alerts";
import { PEG_COLOR } from "../_lib/peg-board-model";
import { pegAlertExplanation } from "../_lib/peg-alert-explanation";
import { ExternalLink, SeverityDot } from "./board-primitives";

const SEVERITY_COLOR: Record<PegAlertSeverity, string> = {
  warning: PEG_COLOR.amber,
  cleared: PEG_COLOR.green,
  page: PEG_COLOR.red,
};

const SEVERITY_LABEL: Record<PegAlertSeverity, string> = {
  warning: "Alert active",
  cleared: "Alert resolved",
  page: "Urgent alert active",
};

const clock = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});
const calendar = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function alertTimestamp(atSeconds: number, nowMs: number): string {
  const at = new Date(atSeconds * 1_000);
  const sameDay = calendar.format(at) === calendar.format(new Date(nowMs));
  return sameDay
    ? `Today ${clock.format(at)}`
    : `${calendar.format(at)} ${clock.format(at)}`;
}

function AlertEntry({
  event,
  monitoring,
  nowMs,
}: {
  event: PegAlertEvent;
  monitoring: PegMonitoringResponse;
  nowMs: number;
}): React.JSX.Element {
  const explanation = pegAlertExplanation(event, monitoring);
  return (
    <li
      data-testid={`peg-alert-${event.id}`}
      className="border-t border-border"
    >
      <details className="group">
        <summary className="grid cursor-pointer list-none grid-cols-[14px_96px_1fr] items-start gap-2.5 px-[18px] py-2.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--primary-border)] [&::-webkit-details-marker]:hidden">
          <span
            className="pt-[5px]"
            role="img"
            aria-label={SEVERITY_LABEL[event.severity]}
          >
            <SeverityDot size={8} color={SEVERITY_COLOR[event.severity]} />
          </span>
          <span className="text-[11.5px]" style={{ color: PEG_COLOR.muted }}>
            {alertTimestamp(event.at, nowMs)}
          </span>
          <span className="flex min-w-0 items-start justify-between gap-3 text-[12.5px] text-[var(--peg-text-2)]">
            <span>
              <strong className="font-[650] text-foreground">
                {event.lead}
              </strong>
              {event.detail === "" ? null : <> — {event.detail}</>}
            </span>
            <span className="shrink-0 text-[11.5px] text-[var(--primary-border)] underline decoration-transparent underline-offset-2 group-hover:decoration-current">
              <span className="group-open:hidden">Details</span>
              <span className="hidden group-open:inline">Hide</span>
            </span>
          </span>
        </summary>
        <div className="grid grid-cols-[14px_96px_1fr] gap-2.5 px-[18px] pb-3">
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <p
            data-testid={`peg-alert-explanation-${event.id}`}
            className="max-w-[78ch] text-[12px] leading-relaxed text-muted-foreground"
          >
            {explanation}
          </p>
        </div>
      </details>
    </li>
  );
}

const SEVEN_DAYS_MS = 7 * 86_400_000;
/** Producer clocks may run slightly ahead of the browser's. */
const FUTURE_SKEW_MS = 60_000;

export function RecentAlerts({
  events,
  monitoring,
  nowMs,
  state,
}: {
  events: readonly PegAlertEvent[];
  monitoring: PegMonitoringResponse;
  nowMs: number;
  state: "loading" | "ready" | "unavailable";
}): React.JSX.Element {
  // The header advertises "last 7 days", so the component enforces it rather
  // than trusting the feed: an older transition (or one stamped further than
  // clock skew into the future) must not render under that label.
  const visible = events.filter((event) => {
    const atMs = event.at * 1_000;
    return atMs >= nowMs - SEVEN_DAYS_MS && atMs <= nowMs + FUTURE_SKEW_MS;
  });
  return (
    <section
      data-testid="peg-recent-alerts"
      aria-label="Recent alerts"
      className="mt-3.5 border border-border"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-[18px] py-3">
        <span>
          <span className="text-[13px] font-[650] text-foreground">
            Recent alerts
          </span>
          <span className="ml-2 text-[12px] text-muted-foreground">
            · last 7 days
          </span>
        </span>
        <ExternalLink
          href={PEG_GRAFANA_ALERTS_URL}
          className="text-[12px] text-[var(--primary-border)]"
        >
          Full history in Grafana
        </ExternalLink>
      </div>
      {state === "loading" ? (
        <p
          role="status"
          className="border-t border-border px-[18px] py-3 text-[12px] text-muted-foreground"
        >
          Loading recent alerts…
        </p>
      ) : state === "unavailable" ? (
        <p
          role="status"
          className="border-t border-border px-[18px] py-3 text-[12px] text-muted-foreground"
        >
          Recent alerts unavailable. Full history remains available in Grafana.
        </p>
      ) : visible.length === 0 ? (
        <p className="border-t border-border px-[18px] py-3 text-[12px] text-muted-foreground">
          No alerts in the last 7 days.
        </p>
      ) : (
        <ul>
          {visible.map((event) => (
            <AlertEntry
              key={event.id}
              event={event}
              monitoring={monitoring}
              nowMs={nowMs}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
