"use client";

import { PEG_GRAFANA_ALERTS_URL } from "@/lib/peg-monitoring";
import { PEG_COLOR } from "../_lib/peg-board-model";
import { ExternalLink, SeverityDot } from "./board-primitives";

type PegAlertSeverity = "warning" | "cleared" | "page" | "policy";

export type PegAlertEvent = {
  id: string;
  /** Unix seconds. */
  at: number;
  severity: PegAlertSeverity;
  /** Bold lead-in, e.g. "EUROP spread warning cleared". */
  lead: string;
  detail: string;
};

const SEVERITY_COLOR: Record<PegAlertSeverity, string> = {
  warning: PEG_COLOR.amber,
  cleared: PEG_COLOR.green,
  page: PEG_COLOR.red,
  policy: PEG_COLOR.purple,
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

/**
 * State transitions and policy activations only. The feed itself lands in a
 * follow-up PR; the row shape is settled here so that change is data-only.
 */
function AlertEntry({
  event,
  nowMs,
}: {
  event: PegAlertEvent;
  nowMs: number;
}): React.JSX.Element {
  return (
    <li
      data-testid={`peg-alert-${event.id}`}
      className="grid grid-cols-[14px_96px_1fr] items-start gap-2.5 border-t border-border px-[18px] py-2.5"
    >
      <span className="pt-[5px]">
        <SeverityDot size={8} color={SEVERITY_COLOR[event.severity]} />
      </span>
      <span className="text-[11.5px]" style={{ color: PEG_COLOR.dim }}>
        {alertTimestamp(event.at, nowMs)}
      </span>
      <span className="text-[12.5px] text-[var(--peg-text-2)]">
        <strong className="font-[650] text-foreground">{event.lead}</strong> —{" "}
        {event.detail}
      </span>
    </li>
  );
}

export function RecentAlerts({
  events,
  nowMs,
}: {
  events?: readonly PegAlertEvent[] | undefined;
  nowMs: number;
}): React.JSX.Element {
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
      {events === undefined || events.length === 0 ? (
        <p className="border-t border-border px-[18px] py-3 text-[12px] text-muted-foreground">
          No alert feed is wired into this page yet. Peg alert transitions and
          policy activations are in{" "}
          <ExternalLink
            href={PEG_GRAFANA_ALERTS_URL}
            className="text-[var(--primary-border)]"
          >
            Grafana
          </ExternalLink>
          .
        </p>
      ) : (
        <ul>
          {events.map((event) => (
            <AlertEntry key={event.id} event={event} nowMs={nowMs} />
          ))}
        </ul>
      )}
    </section>
  );
}
