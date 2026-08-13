/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import type { PegMonitoringResult } from "@/hooks/use-peg-monitoring";
import type { PegHistoryResult } from "@/hooks/use-peg-history";
import {
  makePegMonitoringResponse,
  PEG_FIXTURE_CHAIN_ID,
  PEG_FIXTURE_POOL_ADDRESS,
  PEG_FIXTURE_PRODUCED_AT,
} from "@/test-utils/peg-monitoring-fixture";

const state = vi.hoisted(() => ({
  current: {
    data: null,
    isLoading: true,
    hasError: false,
  } as PegMonitoringResult,
  history: {
    data: null,
    isLoading: false,
    hasError: true,
  } as PegHistoryResult,
}));
vi.mock("@/hooks/use-peg-monitoring", () => ({
  usePegMonitoring: () => state.current,
}));
vi.mock("@/hooks/use-peg-history", () => ({
  usePegHistory: () => state.history,
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { PegMonitoringPageClient } from "../peg-monitoring-page-client";

const POOL_ID = `${PEG_FIXTURE_CHAIN_ID}-${PEG_FIXTURE_POOL_ADDRESS}`;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(PEG_FIXTURE_PRODUCED_AT * 1000 + 20_000);
  state.current = { data: null, isLoading: true, hasError: false };
  state.history = { data: null, isLoading: false, hasError: true };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const render = () => act(() => root.render(<PegMonitoringPageClient />));
const loaded = (data = makePegMonitoringResponse()) => {
  state.current = { data, isLoading: false, hasError: false };
};
const query = (selector: string) => container.querySelector(selector);
/**
 * axe-core drives its rule queue off real `setTimeout`, so the fake clock this
 * suite uses for age ticking has to step aside for the scan.
 */
const auditAccessibility = async () => {
  vi.useRealTimers();
  try {
    return await axe(container);
  } finally {
    vi.useFakeTimers();
    vi.setSystemTime(PEG_FIXTURE_PRODUCED_AT * 1000 + 20_000);
  }
};
const click = (element: Element | null) => {
  expect(element).not.toBeNull();
  act(() => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

describe("PegMonitoringPageClient board", () => {
  it("moves from a board-shaped skeleton to one row per peg", () => {
    render();
    expect(query('[aria-label="Loading peg monitoring"]')).not.toBeNull();
    expect(query('[data-testid="peg-skeleton-board"]')).not.toBeNull();

    loaded();
    render();

    expect(query('[data-testid="peg-skeleton-board"]')).toBeNull();
    const row = query('[data-testid="peg-row-europ-schuman"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("EUROP / EUR");
    expect(row!.textContent).toContain("0.9965");
    expect(row!.textContent).toContain("35 bps below");
    expect(row!.textContent).toContain("Bitvavo EUROP / EUR");
    expect(row!.textContent).toContain("10 bps");
    expect(row!.textContent).toContain("42%");
    expect(row!.textContent).toContain("Ready");
    expect(query('[data-testid="peg-status-europ-schuman"]')!.textContent).toBe(
      "Warning",
    );
  });

  it("states the verdict once, in the header pill", () => {
    loaded();
    render();
    const pill = query('[data-testid="peg-aggregate-status"]');
    expect(pill!.getAttribute("role")).toBe("status");
    expect(pill!.textContent).toBe("0 of 1 peg healthy · 1 warning");
    expect(pill!.getAttribute("aria-label")).toContain(
      "Some pegs need attention",
    );
    expect(container.querySelector("h1")!.textContent).toBe("Peg Monitoring");
    expect(container.textContent).toContain("Checks every 30s");
  });

  it("links every cell that has a destination", () => {
    loaded();
    render();
    const row = query('[data-testid="peg-row-europ-schuman"]')!;
    const venue = row.querySelector(
      'a[href="https://account.bitvavo.com/markets/EUROP-EUR"]',
    );
    expect(venue!.getAttribute("target")).toBe("_blank");
    expect(venue!.getAttribute("rel")).toContain("noopener");
    expect(
      row.querySelector(`a[href="/pool/${POOL_ID}?tab=limits"]`),
    ).not.toBeNull();
    expect(
      row.querySelector(`a[href="/pool/${POOL_ID}?tab=oracle"]`),
    ).not.toBeNull();
  });

  it("toggles the panel from the row and from the chevron, and keeps rows independent", () => {
    loaded();
    render();
    const row = query('[data-testid="peg-row-europ-schuman"]')!;
    const chevron = row.querySelector("button[aria-expanded]")!;
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    expect(query('[data-testid="peg-panel-europ-schuman"]')).toBeNull();

    click(row);
    expect(query('[data-testid="peg-panel-europ-schuman"]')).not.toBeNull();
    expect(
      query('[data-testid="peg-row-europ-schuman"]')!
        .querySelector("button[aria-expanded]")!
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      query('[data-testid="peg-row-europ-schuman"]')!
        .querySelector("button[aria-expanded]")!
        .getAttribute("aria-controls"),
    ).toBe("peg-panel-europ-schuman");

    click(
      query('[data-testid="peg-row-europ-schuman"]')!.querySelector(
        "button[aria-expanded]",
      ),
    );
    expect(query('[data-testid="peg-panel-europ-schuman"]')).toBeNull();
  });

  it("does not toggle when a link inside the row is clicked", () => {
    loaded();
    render();
    click(
      query('[data-testid="peg-row-europ-schuman"]')!.querySelector(
        `a[href="/pool/${POOL_ID}?tab=oracle"]`,
      ),
    );
    expect(query('[data-testid="peg-panel-europ-schuman"]')).toBeNull();
  });

  it("shows supporting markets and a history placeholder inside the panel", () => {
    loaded();
    render();
    click(query('[data-testid="peg-row-europ-schuman"]'));

    const panel = query('[data-testid="peg-panel-europ-schuman"]')!;
    expect(panel.textContent).toContain("Supporting Markets");
    expect(panel.textContent).toContain("Peg History");
    expect(panel.textContent).toContain(
      "Slippage when selling 50k EUROP for EUR on Bitvavo",
    );
    expect(panel.textContent).toContain("History unavailable");

    const kraken = panel.querySelector(
      '[data-testid="peg-supporting-source-kraken_eur"]',
    )!;
    expect(kraken.textContent).toContain("Kraken EUROP / EUR");
    expect(kraken.textContent).toContain("DEPTH ONLY");
    expect(kraken.textContent).toContain("0.9968");
    expect(kraken.textContent).toContain("32 bps below");
    expect(
      panel.querySelector('[data-testid="peg-supporting-source-kraken_usd"]')!
        .textContent,
    ).toContain("DISPLAY ONLY");
    expect(panel.querySelectorAll("[aria-pressed]")).toHaveLength(3);
  });

  it("wires validated history into the expanded asset chart", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    state.history = {
      data: {
        asset: item.asset,
        source: item.policy.deepVenueSource,
        policyVersion: response.producedPolicyVersion,
        range: "7d",
        from: PEG_FIXTURE_PRODUCED_AT - 7 * 86_400,
        to: PEG_FIXTURE_PRODUCED_AT,
        stepSeconds: 1_800,
        points: [
          { at: PEG_FIXTURE_PRODUCED_AT - 3_600, bps: -4 },
          { at: PEG_FIXTURE_PRODUCED_AT, bps: 2 },
        ],
      },
      isLoading: false,
      hasError: false,
    };
    loaded(response);
    render();
    click(query('[data-testid="peg-row-europ-schuman"]'));
    const chart = query('[aria-label*="Peg history over 7d"]')!;
    expect(chart.getAttribute("aria-label")).toContain("2 readings");
    expect(chart.textContent).not.toContain("History unavailable");

    state.history = { ...state.history, hasError: true };
    render();
    expect(
      query('[aria-label*="Peg history over 7d"]')!.getAttribute("aria-label"),
    ).toContain("2 last confirmed readings; refresh failed");
    expect(
      query('[data-testid="peg-panel-europ-schuman"]')!.textContent,
    ).toContain("History refresh failed · showing last confirmed readings");

    state.history = {
      ...state.history,
      data: { ...state.history.data!, points: [] },
      hasError: false,
    };
    render();
    expect(query('[aria-label*="Peg history over 7d"]')!.textContent).toContain(
      "No readings in this window",
    );

    state.history = {
      ...state.history,
      data: {
        ...state.history.data!,
        points: [{ at: PEG_FIXTURE_PRODUCED_AT, bps: -3 }],
      },
    };
    render();
    expect(query('[data-testid="peg-history-single-point"]')).not.toBeNull();
  });

  it("pins an off-scale supporting venue at the rail edge", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    loaded({
      ...response,
      packages: [
        {
          ...item,
          sources: item.sources.map((source) =>
            source.id === "kraken_eur"
              ? { ...source, executablePrice: 0.9866, deviationBps: 134 }
              : source,
          ),
        },
      ],
    });
    render();
    click(query('[data-testid="peg-row-europ-schuman"]'));
    const kraken = query('[data-testid="peg-supporting-source-kraken_eur"]')!;
    expect(kraken.textContent).toContain("134 bps below");
    expect(kraken.textContent).toContain("«");
    expect(
      kraken.querySelector('[role="img"]')!.getAttribute("aria-label"),
    ).toContain("134 bps below");
  });

  it("pins an above-target off-scale venue at the right edge with »", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    loaded({
      ...response,
      packages: [
        {
          ...item,
          sources: item.sources.map((source) =>
            source.id === "kraken_eur"
              ? { ...source, executablePrice: 1.0134, deviationBps: null }
              : source,
          ),
        },
      ],
    });
    render();
    click(query('[data-testid="peg-row-europ-schuman"]'));
    const kraken = query('[data-testid="peg-supporting-source-kraken_eur"]')!;
    expect(kraken.textContent).toContain("134 bps above");
    expect(kraken.textContent).toContain("»");
    expect(kraken.textContent).not.toContain("«");
  });

  it("keeps stale packages readable and marks every age as stale", () => {
    loaded();
    render();
    state.current = { ...state.current, hasError: true };
    render();

    const pill = query('[data-testid="peg-aggregate-status"]')!;
    expect(pill.textContent).toContain("latest data is stale");
    expect(
      query('[data-testid="peg-row-europ-schuman"]')!.textContent,
    ).toContain("· stale");

    click(query('[data-testid="peg-row-europ-schuman"]'));
    expect(
      query('[data-testid="peg-panel-europ-schuman"]')!.textContent,
    ).toContain("Showing the last confirmed check, produced 20s ago.");
  });

  it("keeps a previous-policy notice in the affected row's panel", () => {
    const response = makePegMonitoringResponse();
    loaded({
      ...response,
      producedPolicyVersion: "peg-policy-previous",
      policySlot: "previous",
    });
    render();
    click(query('[data-testid="peg-row-europ-schuman"]'));
    expect(
      query('[data-testid="peg-previous-policy-europ-schuman"]')!.textContent,
    ).toContain("Using the previous alert policy.");
  });

  it("takes the alert state and explains itself when the primary market is unusable", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    loaded({
      ...response,
      packages: [
        {
          ...item,
          sources: item.sources.map((source) =>
            source.id === item.policy.deepVenueSource
              ? { ...source, listingState: "halted", healthy: false }
              : source,
          ),
        },
      ],
    });
    render();
    expect(query('[data-testid="peg-status-europ-schuman"]')!.textContent).toBe(
      "Unconfirmed",
    );
    click(query('[data-testid="peg-row-europ-schuman"]'));
    expect(
      query('[data-testid="peg-primary-unusable-europ-schuman"]')!.textContent,
    ).toContain("Trading is halted on this market.");
  });

  it("lists each monitor's limit and breaker when a package has more than one", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    const monitor = item.monitors[0]!;
    loaded({
      ...response,
      packages: [
        {
          ...item,
          monitors: [
            monitor,
            {
              ...monitor,
              poolAddress: "0x5555555555555555555555555555555555555555",
              structuralSaturation: 0.91,
              breaker: { ...monitor.breaker!, status: "TRIPPED" },
            },
          ],
        },
      ],
    });
    render();
    const row = query('[data-testid="peg-row-europ-schuman"]')!;
    expect(row.textContent).toContain("Tripped");
    expect(
      row.querySelector(
        'a[href="/pool/137-0x5555555555555555555555555555555555555555?tab=oracle"]',
      ),
    ).not.toBeNull();

    click(row);
    const panel = query('[data-testid="peg-panel-europ-schuman"]')!;
    expect(panel.textContent).toContain("trading limit 42% of 80% warn");
    expect(panel.textContent).toContain("trading limit 91% of 80% warn");
  });

  it("never shows numeric trading limits once structural evidence expires", () => {
    // 70s after producedAt: past the tightened 60s freshness grace (structural
    // evidence expired) but inside the 90s package-stale threshold, so the
    // package itself still renders as current.
    vi.setSystemTime(PEG_FIXTURE_PRODUCED_AT * 1000 + 70_000);
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    const monitor = item.monitors[0]!;
    loaded({
      ...response,
      packages: [
        {
          ...item,
          policy: { ...item.policy, freshnessGraceSeconds: 60 },
          monitors: [
            monitor,
            {
              ...monitor,
              poolAddress: "0x5555555555555555555555555555555555555555",
              structuralSaturation: 0.91,
            },
          ],
        },
      ],
    });
    render();
    const row = query('[data-testid="peg-row-europ-schuman"]')!;
    click(row);
    const panel = query('[data-testid="peg-panel-europ-schuman"]')!;
    expect(panel.textContent).toContain("trading limit — (check expired)");
    expect(panel.textContent).not.toContain("42%");
    expect(panel.textContent).not.toContain("91%");
    expect(row.textContent).not.toContain("42%");
  });

  it("does not present incomplete structural queries as numeric trading limits", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    const monitor = item.monitors[0]!;
    loaded({
      ...response,
      packages: [
        {
          ...item,
          structural: {
            ...item.structural,
            structuralQuerySaturated: true,
          },
          monitors: [
            { ...monitor, structuralQuerySaturated: true },
            {
              ...monitor,
              poolAddress: "0x5555555555555555555555555555555555555555",
              structuralSaturation: 0.91,
              structuralQuerySaturated: true,
            },
          ],
        },
      ],
    });
    render();
    const row = query('[data-testid="peg-row-europ-schuman"]')!;
    expect(row.textContent).toContain("Check incomplete");
    expect(row.textContent).not.toContain("42%");

    click(row);
    const panel = query('[data-testid="peg-panel-europ-schuman"]')!;
    expect(panel.textContent).toContain("trading limit — (check incomplete)");
    expect(panel.textContent).not.toContain("42%");
    expect(panel.textContent).not.toContain("91%");
  });

  it("keeps the recent-alerts container with its Grafana fallback", () => {
    loaded();
    render();
    const alerts = query('[data-testid="peg-recent-alerts"]')!;
    expect(alerts.textContent).toContain("Recent alerts");
    expect(alerts.textContent).toContain("· last 7 days");
    expect(
      alerts.querySelectorAll(
        'a[href="https://clabsmento.grafana.net/alerting/list?search=Peg"]',
      ).length,
    ).toBeGreaterThan(0);
  });

  it("falls back to an error box when no package can be shown", () => {
    state.current = { data: null, isLoading: false, hasError: true };
    render();
    expect(container.textContent).toContain("Peg monitoring is unavailable");
  });

  it("passes axe with the board collapsed and expanded", async () => {
    loaded();
    render();
    expect((await auditAccessibility()).violations).toEqual([]);
    click(query('[data-testid="peg-row-europ-schuman"]'));
    expect((await auditAccessibility()).violations).toEqual([]);
  }, 30_000);

  it("ticks per-cell ages between polls", () => {
    loaded();
    render();
    expect(
      query('[data-testid="peg-row-europ-schuman"]')!.textContent,
    ).toContain("checked 25s ago");
    act(() => vi.advanceTimersByTime(20_000));
    expect(
      query('[data-testid="peg-row-europ-schuman"]')!.textContent,
    ).toContain("checked 45s ago");
  });
});
