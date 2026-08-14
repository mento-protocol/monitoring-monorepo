/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecentAlerts, alertTimestamp } from "../_components/recent-alerts";
import type { PegAlertEvent } from "@/lib/peg-alerts";
import { PEG_GRAFANA_ALERTS_URL } from "@/lib/peg-monitoring";

const NOW_MS = Date.UTC(2026, 7, 11, 16, 30);
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const events: PegAlertEvent[] = [
  {
    id: "kesm-warning",
    at: Date.UTC(2026, 7, 11, 16, 5) / 1_000,
    severity: "warning",
    lead: "KESm warning raised",
    detail: "deviation ≥ 25 bps sustained 10 min on VALR. Slack notified.",
  },
  {
    id: "europ-cleared",
    at: Date.UTC(2026, 7, 9, 14, 37) / 1_000,
    severity: "cleared",
    lead: "EUROP spread warning cleared",
    detail: "spread back under 30 bps after 22 min.",
  },
  {
    id: "policy",
    at: Date.UTC(2026, 6, 22, 9, 0) / 1_000,
    severity: "policy",
    lead: "Policy europ-2026-07-22-v1 activated",
    detail: "warn −25, page −50, premium +25.",
  },
];

describe("alertTimestamp", () => {
  it("says Today for same-day events and dates the rest", () => {
    expect(alertTimestamp(events[0]!.at, NOW_MS)).toBe("Today 16:05");
    expect(alertTimestamp(events[1]!.at, NOW_MS)).toBe("Aug 9 14:37");
  });
});

describe("RecentAlerts", () => {
  it("shows an explicit loading state", () => {
    act(() =>
      root.render(<RecentAlerts events={[]} nowMs={NOW_MS} state="loading" />),
    );
    expect(container.textContent).toContain("Recent alerts");
    expect(container.textContent).toContain("· last 7 days");
    expect(container.textContent).toContain("Loading recent alerts…");
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });

  it("keeps the Grafana escape hatch when the feed fails", () => {
    act(() =>
      root.render(
        <RecentAlerts events={[]} nowMs={NOW_MS} state="unavailable" />,
      ),
    );
    expect(container.textContent).toContain("Recent alerts unavailable");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      PEG_GRAFANA_ALERTS_URL,
    );
  });

  it("renders one entry per in-window transition with its severity dot and bold lead", () => {
    act(() =>
      root.render(
        <RecentAlerts nowMs={NOW_MS} events={events} state="ready" />,
      ),
    );
    const rows = container.querySelectorAll("li");
    // The Jul 22 policy activation predates the advertised 7-day window, so
    // the component drops it even though the feed supplied it.
    expect(rows).toHaveLength(2);
    expect(
      container.querySelector('[data-testid="peg-alert-policy"]'),
    ).toBeNull();
    expect(rows[0]!.querySelector("strong")!.textContent).toBe(
      "KESm warning raised",
    );
    // Every bold lead gets the same colour treatment; the mockup was
    // inconsistent about this.
    const leadClasses = Array.from(container.querySelectorAll("strong")).map(
      (lead) => lead.className,
    );
    expect(new Set(leadClasses).size).toBe(1);
    expect(container.textContent).toContain("Today 16:05");
    expect(container.textContent).toContain("Aug 9 14:37");
  });

  it("renders an in-window policy activation with the brand-purple dot", () => {
    const recentPolicy: PegAlertEvent = {
      ...events[2]!,
      at: Date.UTC(2026, 7, 10, 9, 0) / 1_000,
    };
    act(() =>
      root.render(
        <RecentAlerts nowMs={NOW_MS} events={[recentPolicy]} state="ready" />,
      ),
    );
    expect(
      container.querySelector('[data-testid="peg-alert-policy"]')!.textContent,
    ).toContain(
      "Policy europ-2026-07-22-v1 activated — warn −25, page −50, premium +25.",
    );
  });

  it("says so when a wired feed has no events inside the window", () => {
    act(() =>
      root.render(
        <RecentAlerts nowMs={NOW_MS} events={[events[2]!]} state="ready" />,
      ),
    );
    expect(container.textContent).toContain("No alerts in the last 7 days.");
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });
});
