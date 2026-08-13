/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RecentAlerts,
  alertTimestamp,
  type PegAlertEvent,
} from "../_components/recent-alerts";

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

/**
 * The feed itself lands in a follow-up PR. These cover the entry row that PR
 * will bind data to, so the change stays data-only.
 */
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
  it("falls back to the Grafana link while no feed is wired", () => {
    act(() => root.render(<RecentAlerts nowMs={NOW_MS} />));
    expect(container.textContent).toContain("Recent alerts");
    expect(container.textContent).toContain("· last 7 days");
    expect(container.textContent).toContain(
      "No alert feed is wired into this page yet",
    );
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });

  it("renders one entry per transition with its severity dot and bold lead", () => {
    act(() => root.render(<RecentAlerts nowMs={NOW_MS} events={events} />));
    const rows = container.querySelectorAll("li");
    expect(rows).toHaveLength(3);
    expect(
      container.querySelector('[data-testid="peg-alert-policy"]')!.textContent,
    ).toContain(
      "Policy europ-2026-07-22-v1 activated — warn −25, page −50, premium +25.",
    );
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
});
