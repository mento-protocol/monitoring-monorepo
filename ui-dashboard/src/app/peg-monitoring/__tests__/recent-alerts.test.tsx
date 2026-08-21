/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecentAlerts, alertTimestamp } from "../_components/recent-alerts";
import { pegAlertExplanation } from "../_lib/peg-alert-explanation";
import type { PegAlertEvent } from "@/lib/peg-alerts";
import { PEG_GRAFANA_ALERTS_URL } from "@/lib/peg-monitoring";
import { makePegMonitoringResponse } from "@/test-utils/peg-monitoring-fixture";

const NOW_MS = Date.UTC(2026, 7, 11, 16, 30);
let container: HTMLDivElement;
let root: Root;
const monitoring = makePegMonitoringResponse();

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
    lead: "VALR sell price is 25 bps below peg",
    detail: "KESm.",
    evidence: {
      rule: "Downside Warning",
      assetId: "kesm-current",
      assetName: "KESm",
      sourceId: "valr_zar",
      sourceName: "VALR",
      quoteCurrency: "ZAR",
      policyVersion: "kesm-v1",
      failureReason: null,
    },
  },
  {
    id: "europ-cleared",
    at: Date.UTC(2026, 7, 9, 14, 37) / 1_000,
    severity: "cleared",
    lead: "Bitvavo buy and sell prices were 30 bps apart",
    detail: "EUROP · lasted 22 min.",
    evidence: {
      rule: "Deep-Venue Spread Warning",
      assetId: "europ-schuman",
      assetName: "EUROP",
      sourceId: "bitvavo_eur",
      sourceName: "Bitvavo",
      quoteCurrency: "EUR",
      policyVersion: monitoring.producedPolicyVersion,
      failureReason: null,
    },
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
      root.render(
        <RecentAlerts
          events={[]}
          monitoring={monitoring}
          nowMs={NOW_MS}
          state="loading"
        />,
      ),
    );
    expect(container.textContent).toContain("Recent alerts");
    expect(container.textContent).toContain("· last 7 days");
    expect(container.textContent).toContain("Loading recent alerts…");
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });

  it("keeps the Grafana escape hatch when the feed fails", () => {
    act(() =>
      root.render(
        <RecentAlerts
          events={[]}
          monitoring={monitoring}
          nowMs={NOW_MS}
          state="unavailable"
        />,
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
        <RecentAlerts
          nowMs={NOW_MS}
          events={events}
          monitoring={monitoring}
          state="ready"
        />,
      ),
    );
    const rows = container.querySelectorAll("li");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector("strong")!.textContent).toBe(
      "VALR sell price is 25 bps below peg",
    );
    // Every bold lead gets the same colour treatment; the mockup was
    // inconsistent about this.
    const leadClasses = Array.from(container.querySelectorAll("strong")).map(
      (lead) => lead.className,
    );
    expect(new Set(leadClasses).size).toBe(1);
    expect(container.textContent).toContain("Today 16:05");
    expect(container.textContent).toContain("Aug 9 14:37");
    expect(
      rows[0]!.querySelector('[role="img"]')?.getAttribute("aria-label"),
    ).toBe("Alert active");
    expect(
      rows[1]!.querySelector('[role="img"]')?.getAttribute("aria-label"),
    ).toBe("Alert resolved");
  });

  it("reveals a precise explanation through the row disclosure", () => {
    act(() =>
      root.render(
        <RecentAlerts
          nowMs={NOW_MS}
          events={[events[1]!]}
          monitoring={monitoring}
          state="ready"
        />,
      ),
    );
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    act(() => details.querySelector("summary")!.click());
    expect(details.open).toBe(true);
    expect(details.textContent).toContain(
      "The gap between the best available buy and sell prices exceeded the allowed spread.",
    );
    expect(details.textContent).toContain(
      "The alert fires after the gap remains too wide for 10 minutes.",
    );
  });

  it("labels and explains Grafana evaluation failures without breach copy", () => {
    const failure: PegAlertEvent = {
      ...events[0]!,
      id: "grafana-evaluation-failed",
      severity: "page",
      lead: "Grafana could not evaluate the Bitvavo Peg rule",
      detail: "EUROP.",
      evidence: {
        ...events[1]!.evidence,
        rule: "Deep-Venue Downside Critical",
        failureReason: null,
        evaluationState: "failed",
      },
    };
    act(() =>
      root.render(
        <RecentAlerts
          nowMs={NOW_MS}
          events={[failure]}
          monitoring={monitoring}
          state="ready"
        />,
      ),
    );

    const row = container.querySelector("li")!;
    expect(row.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Monitoring failed",
    );
    act(() => row.querySelector("summary")!.click());
    expect(row.textContent).toContain(
      "This entry records a monitoring failure and does not confirm a peg breach.",
    );
    expect(row.textContent).not.toContain(
      "The monitor uses the average price available when selling the monitored amount",
    );
  });

  it("labels and explains monitoring recovery into Pending", () => {
    const recovery: PegAlertEvent = {
      ...events[0]!,
      id: "grafana-evaluation-recovered-pending",
      severity: "warning",
      lead: "Grafana can evaluate the Bitvavo Peg rule again; its alert condition is pending",
      detail: "EUROP · lasted 1 min.",
      evidence: {
        ...events[0]!.evidence,
        evaluationState: "recovered-pending",
      },
    };
    act(() =>
      root.render(
        <RecentAlerts
          nowMs={NOW_MS}
          events={[recovery]}
          monitoring={monitoring}
          state="ready"
        />,
      ),
    );

    const row = container.querySelector("li")!;
    expect(row.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Monitoring recovered; alert pending",
    );
    act(() => row.querySelector("summary")!.click());
    expect(row.textContent).toContain(
      "Grafana resumed evaluating this Peg rule, and the rule entered Pending.",
    );
  });

  it("omits the separator when the cause needs no detail", () => {
    act(() =>
      root.render(
        <RecentAlerts
          nowMs={NOW_MS}
          events={[{ ...events[0]!, detail: "" }]}
          monitoring={monitoring}
          state="ready"
        />,
      ),
    );
    expect(container.querySelector("li")?.textContent).not.toContain("—");
  });

  it("says so when a wired feed has no events inside the window", () => {
    act(() =>
      root.render(
        <RecentAlerts
          nowMs={NOW_MS}
          events={[{ ...events[0]!, at: Date.UTC(2026, 6, 22, 9, 0) / 1_000 }]}
          monitoring={monitoring}
          state="ready"
        />,
      ),
    );
    expect(container.textContent).toContain("No alerts in the last 7 days.");
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });
});

describe("pegAlertExplanation", () => {
  it("does not apply current thresholds to a historical policy", () => {
    expect(pegAlertExplanation(events[0]!, monitoring)).toBe(
      "The monitor uses the average price available when selling the monitored amount, not the midpoint between buy and sell prices.",
    );
  });

  it("states the exact stale-data age and alert wait", () => {
    const staleEvent: PegAlertEvent = {
      id: "kraken-stale",
      at: NOW_MS / 1_000,
      severity: "warning",
      lead: "Kraken price data is too old",
      detail: "EUROP.",
      evidence: {
        rule: "Source Unhealthy",
        assetId: "europ-schuman",
        assetName: "EUROP",
        sourceId: "kraken_eur",
        sourceName: "Kraken",
        quoteCurrency: "EUR",
        policyVersion: monitoring.producedPolicyVersion,
        failureReason: 6,
      },
    };

    expect(pegAlertExplanation(staleEvent, monitoring)).toBe(
      "The latest Kraken EUROP/EUR price was more than 5 minutes old. The alert fires after the data remains too old for 30 minutes.",
    );
    expect(
      pegAlertExplanation(
        {
          ...staleEvent,
          severity: "cleared",
          lead: "Kraken price data is fresh again",
        },
        monitoring,
      ),
    ).toBe(
      "A fresh Kraken EUROP/EUR price arrived, so the alert cleared. The alert fires after the data remains too old for 30 minutes.",
    );
  });

  it("explains a legacy Bitvavo fallback without inventing a cause", () => {
    const fallbackEvent: PegAlertEvent = {
      id: "bitvavo-legacy",
      at: NOW_MS / 1_000,
      severity: "warning",
      lead: "Bitvavo sell price is unavailable",
      detail: "EUROP.",
      evidence: {
        rule: "Blind Warning",
        assetId: "europ-schuman",
        assetName: "EUROP",
        sourceId: "bitvavo_eur",
        sourceName: "Bitvavo",
        quoteCurrency: "EUR",
        policyVersion: monitoring.producedPolicyVersion,
        failureReason: null,
      },
    };

    expect(pegAlertExplanation(fallbackEvent, monitoring)).toBe(
      "The monitor could not calculate a current Bitvavo sell price for the monitored amount. The alert fired after 10 checks in a row without a usable sell price (about 5 minutes). The exact cause was not recorded.",
    );
    expect(
      pegAlertExplanation(
        {
          ...fallbackEvent,
          evidence: {
            ...fallbackEvent.evidence,
            policyVersion: "older-policy",
          },
        },
        monitoring,
      ),
    ).toBe(
      "The monitor could not calculate a current Bitvavo sell price for the monitored amount. The exact cause was not recorded.",
    );
  });

  it.each(["Blind Warning", "Blind While Stressed Critical"] as const)(
    "includes the blind threshold for a classified %s failure",
    (rule) => {
      const event: PegAlertEvent = {
        id: `bitvavo-${rule}`,
        at: NOW_MS / 1_000,
        severity: "warning",
        lead: "Bitvavo sell price is unavailable",
        detail: "EUROP.",
        evidence: {
          rule,
          assetId: "europ-schuman",
          assetName: "EUROP",
          sourceId: "bitvavo_eur",
          sourceName: "Bitvavo",
          quoteCurrency: "EUR",
          policyVersion: monitoring.producedPolicyVersion,
          failureReason: 1,
        },
      };

      expect(pegAlertExplanation(event, monitoring)).toBe(
        "HTTP 429 means Bitvavo received too many price requests in a short period. The alert fired after 10 checks in a row without a usable sell price (about 5 minutes).",
      );
    },
  );

  it("includes the blind threshold for a stale-data failure", () => {
    const event: PegAlertEvent = {
      id: "bitvavo-blind-stale",
      at: NOW_MS / 1_000,
      severity: "warning",
      lead: "Bitvavo sell price is unavailable",
      detail: "EUROP.",
      evidence: {
        rule: "Blind Warning",
        assetId: "europ-schuman",
        assetName: "EUROP",
        sourceId: "bitvavo_eur",
        sourceName: "Bitvavo",
        quoteCurrency: "EUR",
        policyVersion: monitoring.producedPolicyVersion,
        failureReason: 6,
      },
    };

    expect(pegAlertExplanation(event, monitoring)).toBe(
      "The latest Bitvavo EUROP/EUR price was more than 2 minutes old. The alert fired after 10 checks in a row without a usable sell price (about 5 minutes).",
    );
  });

  it("distinguishes an unclassified new failure from missing history", () => {
    const event: PegAlertEvent = {
      id: "unclassified",
      at: NOW_MS / 1_000,
      severity: "warning",
      lead: "Bitvavo sell price is unavailable",
      detail: "EUROP.",
      evidence: {
        rule: "Source Unhealthy",
        assetId: "europ-schuman",
        assetName: "EUROP",
        sourceId: "bitvavo_eur",
        sourceName: "Bitvavo",
        quoteCurrency: "EUR",
        policyVersion: monitoring.producedPolicyVersion,
        failureReason: 18,
      },
    };

    expect(pegAlertExplanation(event, monitoring)).toBe(
      "The monitor could not calculate a current Bitvavo sell price for the monitored amount. The alert fires after the problem continues for 1 minute. The monitor did not classify the cause.",
    );
  });

  it("uses the rollover threshold only for the approved policy", () => {
    const event: PegAlertEvent = {
      id: "rollover-stuck",
      at: NOW_MS / 1_000,
      severity: "warning",
      lead: `Peg monitor has not loaded policy ${monitoring.approvedActivePolicyVersion}`,
      detail: "",
      evidence: {
        rule: "Policy Rollover Stuck",
        assetId: "policy",
        assetName: "policy",
        sourceId: "",
        sourceName: "",
        quoteCurrency: null,
        policyVersion: monitoring.approvedActivePolicyVersion,
        failureReason: null,
      },
    };

    expect(pegAlertExplanation(event, monitoring)).toBe(
      "The Peg monitor did not load the approved policy within 5 minutes.",
    );
    expect(
      pegAlertExplanation(
        {
          ...event,
          evidence: { ...event.evidence, policyVersion: "older-policy" },
        },
        monitoring,
      ),
    ).toBe(
      "The Peg monitor did not load the approved policy within the allowed time.",
    );
  });

  it("uses recovery wording when source support and listing alerts clear", () => {
    const event: PegAlertEvent = {
      id: "source-recovered",
      at: NOW_MS / 1_000,
      severity: "cleared",
      lead: "Bitvavo is supported by the monitor again",
      detail: "EUROP.",
      evidence: {
        rule: "Source Unhealthy",
        assetId: "europ-schuman",
        assetName: "EUROP",
        sourceId: "bitvavo_eur",
        sourceName: "Bitvavo",
        quoteCurrency: "EUR",
        policyVersion: monitoring.producedPolicyVersion,
        failureReason: 17,
      },
    };

    expect(pegAlertExplanation(event, monitoring)).toBe(
      "The Peg monitor supports Bitvavo again. The alert fires after the problem continues for 1 minute.",
    );
    expect(
      pegAlertExplanation(
        {
          ...event,
          evidence: { ...event.evidence, failureReason: 20 },
        },
        monitoring,
      ),
    ).toBe(
      "Bitvavo now reports that it lists the EUROP/EUR market. The alert fires after the problem continues for 1 minute.",
    );
    expect(
      pegAlertExplanation(
        {
          ...event,
          evidence: {
            ...event.evidence,
            rule: "Registry Rot",
            failureReason: null,
          },
        },
        monitoring,
      ),
    ).toBe(
      "Bitvavo now reports that it lists the EUROP/EUR market. The original alert fired after 2 consecutive listing checks reported the market missing.",
    );
  });
});
