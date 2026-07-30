/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PegMonitoringResult } from "@/hooks/use-peg-monitoring";
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
}));
vi.mock("@/hooks/use-peg-monitoring", () => ({
  usePegMonitoring: () => state.current,
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
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(PEG_FIXTURE_PRODUCED_AT * 1000 + 20_000);
  state.current = { data: null, isLoading: true, hasError: false };
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
describe("PegMonitoringPageClient", () => {
  it("keeps a page-shaped loading skeleton and transitions through retained stale, unavailable, and recovery", () => {
    render();
    expect(
      container.querySelector('[aria-label="Loading peg monitoring"]'),
    ).not.toBeNull();
    state.current = {
      data: makePegMonitoringResponse(),
      isLoading: false,
      hasError: false,
    };
    render();
    expect(container.textContent).toContain("Data is current");
    expect(
      container.querySelector(
        `a[href="/pool/${PEG_FIXTURE_CHAIN_ID}-${PEG_FIXTURE_POOL_ADDRESS}?tab=oracle"]`,
      ),
    ).not.toBeNull();
    const grafana = container.querySelector(
      'a[href^="https://clabsmento.grafana.net/"]',
    );
    expect(grafana?.getAttribute("rel")).toContain("noopener");
    state.current = { ...state.current, hasError: true };
    render();
    expect(container.textContent).toContain(
      "Data is stale — showing the last confirmed check",
    );
    expect(container.textContent).toContain("Last confirmed conclusion");
    expect(container.textContent).toContain("europ-schuman / EUR");
    state.current = { data: null, isLoading: false, hasError: true };
    render();
    expect(container.textContent).toContain("Peg monitoring is unavailable");
    state.current = {
      data: makePegMonitoringResponse(),
      isLoading: false,
      hasError: false,
    };
    render();
    expect(container.textContent).toContain("Data is current");
  });
  it("puts plain decision evidence first and keeps supporting and technical detail collapsed", () => {
    state.current = {
      data: makePegMonitoringResponse(),
      isLoading: false,
      hasError: false,
    };

    render();

    const evidence = container.querySelector(
      '[data-testid="peg-evidence-policy"]',
    );
    const otherMarkets = container.querySelector(
      '[data-testid="peg-other-markets-europ-schuman"]',
    );
    const technical = container.querySelector(
      '[data-testid="peg-technical-record"]',
    );
    expect(evidence?.querySelector("summary")?.textContent).toContain(
      "How this status was checked",
    );
    expect(container.textContent).toContain(
      "This is the market used to set the status above.",
    );
    expect(container.textContent).toContain(
      "A 50,000 EUROP sale would get about 0.9965 EUR per EUROP.",
    );
    expect(container.textContent).toContain(
      "A warning fires after 10 minutes when the price is 0.25% (25 bps) below target or 0.25% (25 bps) above target, or when the decision market's buy/sell spread exceeds 30 bps, or when pool inflow reaches 80% of its active trading limit.",
    );
    expect(container.textContent).toContain(
      "Also page immediately when the full-size sale price is missing for 10 consecutive checks and another risk signal is active: high pool inflow, an unusually wide buy/sell spread, or a partial-fill price below the critical limit.",
    );
    expect(container.textContent).toContain(
      "80% of usable readings must cross the limit",
    );
    expect(container.textContent).toContain(
      "Net pool inflow is at 42% of the active on-chain trading limit. Warn at 80%.",
    );
    expect(otherMarkets?.hasAttribute("open")).toBe(false);
    expect(otherMarkets?.textContent).toContain(
      "Secondary markets can raise separate market warnings; the status above uses the decision market. Display-only markets do not affect peg price status, but their health or listing can raise operational warnings.",
    );
    expect(container.textContent).toContain(
      "Separate operations warnings cover market availability and listings, pool reachability, missed checks, and policy rollover. They do not page the on-call engineer.",
    );
    expect(container.textContent).toContain("Other non-paging warnings");
    expect(container.textContent).toContain(
      "A trade safeguard problem makes this dashboard critical, but it does not page the on-call engineer by itself.",
    );
    expect(technical?.hasAttribute("open")).toBe(false);
    expect(technical?.textContent).toContain("Schema");
  });
  it("keeps alert settings available when the decision market is absent", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    state.current = {
      data: {
        ...response,
        packages: [
          {
            ...item,
            sources: item.sources.filter(
              (source) => source.id !== item.policy.deepVenueSource,
            ),
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };

    render();

    const settings = container.querySelector(
      '[data-testid="peg-alert-settings-europ-schuman"]',
    );
    expect(settings?.textContent).toContain(
      "A warning fires after 10 minutes when the price is 0.25% (25 bps) below target or 0.25% (25 bps) above target, or when pool inflow reaches 80% of its active trading limit.",
    );
    expect(settings?.textContent).not.toContain(
      "decision market's buy/sell spread exceeds",
    );
  });
  it("keeps the ticking age outside the live status while announcing semantic state", () => {
    state.current = {
      data: makePegMonitoringResponse(),
      isLoading: false,
      hasError: false,
    };
    render();
    const status = container.querySelector('[data-testid="peg-status"]');
    const liveStatus = status?.querySelector('[role="status"]');
    const age = status?.querySelector('[data-testid="peg-status-age"]');
    expect(liveStatus?.textContent).toBe("Data is current");
    expect(age?.textContent).toContain("Produced 20s ago");
    expect(liveStatus?.contains(age ?? null)).toBe(false);

    act(() => vi.advanceTimersByTime(80_000));
    const staleStatus = container.querySelector('[data-testid="peg-status"]');
    const staleLiveStatus = staleStatus?.querySelector('[role="status"]');
    const staleAge = staleStatus?.querySelector(
      '[data-testid="peg-status-age"]',
    );
    expect(staleLiveStatus?.textContent).toContain(
      "Data is stale — showing the last confirmed check",
    );
    expect(staleAge?.textContent).toContain("Produced 1m ago.");
    expect(staleLiveStatus?.contains(staleAge ?? null)).toBe(false);
    expect(container.textContent).toContain(
      "At the last confirmed check, a 50,000 EUROP sale would have received about 0.9965 EUR per EUROP.",
    );
    expect(
      Array.from(container.querySelectorAll("span")).some(
        ({ textContent }) => textContent === "Last confirmed",
      ),
    ).toBe(true);

    const aggregateStatus = container.querySelector(
      '[data-testid="peg-aggregate-status"]',
    );
    const aggregateAge = container.querySelector(
      '[data-testid="peg-aggregate-age"]',
    );
    const aggregateText = aggregateStatus?.textContent;
    expect(aggregateText).toContain("Latest data is stale");
    expect(aggregateText).toContain(
      "values below are the last confirmed measurements",
    );
    expect(aggregateText).not.toMatch(/\b\d+[smh]\b/);
    expect(aggregateStatus?.contains(aggregateAge ?? null)).toBe(false);

    act(() => vi.advanceTimersByTime(60_000));
    expect(aggregateStatus?.textContent).toBe(aggregateText);
    expect(
      container.querySelector('[data-testid="peg-aggregate-age"]')?.textContent,
    ).toContain("2m old");
  });
  it("uses live supporting-source freshness until the package becomes stale, then keeps the confirmed result", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    vi.setSystemTime(PEG_FIXTURE_PRODUCED_AT * 1_000 + 50_000);
    state.current = {
      data: {
        ...response,
        packages: [
          {
            ...item,
            sources: item.sources.map((source) =>
              source.id === "kraken_eur"
                ? {
                    ...source,
                    policy: {
                      ...source.policy,
                      pollIntervalSeconds: 15,
                      staleAfterSeconds: 30,
                    },
                  }
                : source,
            ),
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };

    render();

    let supportingSource = container.querySelector(
      '[data-testid="peg-supporting-source-kraken_eur"]',
    );
    expect(container.textContent).toContain("Data is current");
    expect(supportingSource?.textContent).toContain("Unavailable");

    act(() => vi.advanceTimersByTime(50_000));
    supportingSource = container.querySelector(
      '[data-testid="peg-supporting-source-kraken_eur"]',
    );
    expect(container.textContent).toContain(
      "Data is stale — showing the last confirmed check",
    );
    expect(supportingSource?.textContent).toContain("Last confirmed");
    expect(supportingSource?.textContent).not.toContain("Unavailable");
  });
  it("keeps the decision-market sale measurement from the last confirmed package", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    vi.setSystemTime(PEG_FIXTURE_PRODUCED_AT * 1_000 + 50_000);
    state.current = {
      data: {
        ...response,
        packages: [
          {
            ...item,
            sources: item.sources.map((source) =>
              source.id === item.policy.deepVenueSource
                ? {
                    ...source,
                    policy: { ...source.policy, staleAfterSeconds: 30 },
                  }
                : source,
            ),
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };

    render();
    expect(container.textContent).toContain("Price check unavailable");

    act(() => vi.advanceTimersByTime(50_000));
    const decisionMarket = container.querySelector(
      '[data-testid="peg-decision-market-europ-schuman"]',
    );
    const scorecard = container.querySelector(
      '[data-testid="peg-scorecard-europ-schuman"]',
    );
    expect(container.textContent).toContain(
      "Data is stale — showing the last confirmed check",
    );
    expect(decisionMarket?.textContent).toContain("Last confirmed");
    expect(decisionMarket?.textContent).toContain(
      "At the last confirmed check, a 50,000 EUROP sale would have received about 0.9965 EUR per EUROP.",
    );
    expect(decisionMarket?.textContent).not.toContain("Unavailable");
    expect(scorecard?.textContent).not.toContain(
      "Last confirmed executable price is unavailable",
    );
    expect(
      scorecard?.querySelector('[data-testid="peg-current-europ-schuman"]'),
    ).not.toBeNull();
  });
  it("keeps confirmed structural results visible after the package becomes stale", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    const monitor = item.monitors[0]!;
    state.current = {
      data: {
        ...response,
        packages: [
          {
            ...item,
            policy: { ...item.policy, freshnessGraceSeconds: 60 },
            structural: { ...item.structural, indexedPoolReachable: false },
            monitors: [
              {
                ...monitor,
                breaker: { ...monitor.breaker!, enabled: false },
              },
            ],
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };

    render();
    act(() => vi.advanceTimersByTime(100_000));
    const safety = container.querySelector(
      '[data-testid="peg-safety-checks-europ-schuman"]',
    );
    expect(container.textContent).toContain(
      "Data is stale — showing the last confirmed check",
    );
    expect(safety?.textContent).toContain("Pool unavailable");
    expect(safety?.textContent).toContain("Disabled");
    expect(safety?.textContent).not.toContain("Check expired");
  });
  it("labels capped supporting-market prices as partial fills", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    state.current = {
      data: {
        ...response,
        packages: [
          {
            ...item,
            sources: item.sources.map((source) =>
              source.id === "kraken_eur"
                ? { ...source, capped: true, filledFraction: 0.4 }
                : source,
            ),
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };

    render();
    const supporting = container.querySelector(
      '[data-testid="peg-supporting-source-kraken_eur"]',
    );
    expect(supporting?.textContent).toContain(
      "partial fill: 40% of the test sale",
    );
    expect(supporting?.textContent).not.toContain(
      "for a 50,000 EUROP test sale",
    );
  });
  it("expires source evidence while its package is still current", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    state.current = {
      data: {
        ...response,
        packages: [
          {
            ...item,
            sources: item.sources.map((source) =>
              source.id === item.policy.deepVenueSource
                ? {
                    ...source,
                    executablePrice: 0.999,
                    deviationBps: 10,
                    premiumBps: 0,
                    observationAt: response.producedAt - 100,
                  }
                : source,
            ),
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };

    render();
    expect(container.textContent).toContain("Data is current");
    expect(container.textContent).toContain("All pegs healthy");
    expect(container.textContent).toContain("3 of 3 sources usable");

    act(() => vi.advanceTimersByTime(10_000));
    expect(container.textContent).toContain("Data is current");
    expect(container.textContent).toContain("Price check unavailable");
    expect(container.textContent).toContain("2 of 3 sources usable");
    expect(container.textContent).not.toContain("3 of 3 sources healthy");
    const marketLabel = Array.from(container.querySelectorAll("dt")).find(
      ({ textContent }) => textContent === "Market",
    );
    expect(marketLabel?.nextElementSibling?.textContent).toBe("Unavailable");
    expect(container.textContent).toContain(
      "The policy-selected market observation is older than its allowed freshness window.",
    );
    expect(
      container.querySelector('[data-testid="peg-current-europ-schuman"]'),
    ).toBeNull();
  });
  it("expires structural checks while price evidence and the package remain current", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    state.current = {
      data: {
        ...response,
        packages: [
          {
            ...item,
            policy: { ...item.policy, freshnessGraceSeconds: 60 },
            sources: item.sources.map((source) => ({
              ...source,
              executablePrice:
                source.id === item.policy.deepVenueSource
                  ? 0.999
                  : source.executablePrice,
              deviationBps:
                source.id === item.policy.deepVenueSource
                  ? 10
                  : source.deviationBps,
              premiumBps:
                source.id === item.policy.deepVenueSource
                  ? 0
                  : source.premiumBps,
              policy: {
                ...source.policy,
                pollIntervalSeconds: Math.min(
                  source.policy.pollIntervalSeconds,
                  60,
                ),
              },
            })),
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };

    render();
    expect(container.textContent).toContain("All pegs healthy");
    expect(container.textContent).toContain("1 pool reachable");

    act(() => vi.advanceTimersByTime(50_000));
    expect(container.textContent).toContain("Data is current");
    expect(container.textContent).toContain("Monitoring checks incomplete");
    expect(container.textContent).toContain("Check expired");
    expect(container.textContent).toContain("3 of 3 sources usable");
    expect(container.textContent).toContain(
      "The structural checks are older than the policy's freshness window.",
    );
    expect(
      container.querySelector('[data-testid="peg-current-europ-schuman"]'),
    ).not.toBeNull();
  });
  it("expires breaker conclusions with the structural check", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    state.current = {
      data: {
        ...response,
        packages: [
          {
            ...item,
            policy: { ...item.policy, freshnessGraceSeconds: 60 },
            monitors: item.monitors.map((monitor) => ({
              ...monitor,
              breaker:
                monitor.breaker === null
                  ? null
                  : { ...monitor.breaker, enabled: false },
            })),
            sources: item.sources.map((source) => ({
              ...source,
              executablePrice:
                source.id === item.policy.deepVenueSource
                  ? 0.999
                  : source.executablePrice,
              deviationBps:
                source.id === item.policy.deepVenueSource
                  ? 10
                  : source.deviationBps,
              premiumBps:
                source.id === item.policy.deepVenueSource
                  ? 0
                  : source.premiumBps,
              policy: {
                ...source.policy,
                pollIntervalSeconds: Math.min(
                  source.policy.pollIntervalSeconds,
                  60,
                ),
              },
            })),
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };

    render();
    expect(container.textContent).toContain("Critical condition detected");
    expect(container.textContent).toContain("0 of 1 breakers OK");

    act(() => vi.advanceTimersByTime(50_000));
    expect(container.textContent).toContain("Monitoring checks incomplete");
    expect(container.textContent).not.toContain(
      "Critical condition in the current package",
    );
    const breakerLabel = Array.from(container.querySelectorAll("dt")).find(
      ({ textContent }) => textContent === "Breaker",
    );
    expect(breakerLabel?.nextElementSibling?.textContent).toBe("Check expired");
  });
  it("renders previous-policy, partial source evidence, disabled breaker, and null breaker distinctly", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    const monitor = item.monitors[0]!;
    state.current = {
      data: {
        ...response,
        producedPolicyVersion: "peg-policy-previous",
        policySlot: "previous",
        packages: [
          {
            ...item,
            sources: [
              {
                ...item.sources[0]!,
                healthy: false,
                executablePrice: null,
                observationAt: null,
                fetchedAt: null,
              },
            ],
            monitors: [
              { ...monitor, breaker: { ...monitor.breaker!, enabled: false } },
              {
                ...monitor,
                poolAddress: "0x5555555555555555555555555555555555555555",
                breaker: null,
              },
            ],
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };
    render();
    expect(container.textContent).toContain("Using the previous alert policy");
    expect(container.textContent).toContain("Unhealthy");
    const disabled = Array.from(container.querySelectorAll("span")).find(
      (element) => element.textContent === "Disabled",
    );
    expect(disabled?.className).toContain("text-red-300");
    expect(container.textContent).toContain("Safeguard unavailable");
    expect(container.textContent).toContain("0 of 2 breakers OK");
  });
  it("keeps unavailable breakers in the health-summary denominator", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    const monitor = item.monitors[0]!;
    state.current = {
      data: {
        ...response,
        packages: [
          {
            ...item,
            monitors: [
              monitor,
              {
                ...monitor,
                rateFeedId: "0x6666666666666666666666666666666666666666",
                breaker: null,
              },
            ],
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };

    render();

    expect(container.textContent).toContain("1 of 2 breakers OK");
  });
  it("keeps a current critical condition red when another check is incomplete", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    state.current = {
      data: {
        ...response,
        packages: [
          {
            ...item,
            structural: { ...item.structural, blind: true },
            sources: item.sources.map((source) =>
              source.id === item.policy.deepVenueSource
                ? {
                    ...source,
                    executablePrice: 0.995,
                    deviationBps: item.policy.criticalDeviationBps,
                    premiumBps: 0,
                  }
                : source,
            ),
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };

    render();

    const aggregate = container.querySelector(
      '[data-testid="peg-aggregate-status"]',
    );
    expect(aggregate?.textContent).toContain("Critical condition detected");
    expect(aggregate?.parentElement?.className).toContain("border-red");
    expect(container.textContent).toContain(
      "Critical condition in the current package",
    );
    expect(container.textContent).toContain(
      "The alert only fires if enough readings stay there long enough.",
    );
    expect(container.textContent).not.toContain("Action required");
    expect(
      container.querySelector('[data-testid="peg-current-europ-schuman"]')
        ?.className,
    ).toContain("bg-red-600");
  });
  it("leads critical evidence with the critical cause when another check is incomplete", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    state.current = {
      data: {
        ...response,
        packages: [
          {
            ...item,
            structural: {
              ...item.structural,
              structuralQuerySaturated: true,
            },
            sources: item.sources.map((source) =>
              source.id === item.policy.deepVenueSource
                ? {
                    ...source,
                    executablePrice: 0.995,
                    deviationBps: item.policy.criticalDeviationBps,
                    premiumBps: 0,
                  }
                : source,
            ),
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };

    render();

    const evidenceAlert = container.querySelector(
      '[data-testid="peg-evidence-policy"] [role="alert"]',
    );
    expect(evidenceAlert?.textContent).toContain(
      "The alert only fires if enough readings stay there long enough.",
    );
    expect(evidenceAlert?.textContent).not.toContain("result limit");
  });
  it("renders confirmed blind-while-stressed evidence as critical", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    state.current = {
      data: {
        ...response,
        packages: [
          {
            ...item,
            structural: {
              ...item.structural,
              blind: true,
              blindConsecutivePolls: item.policy.blindConsecutivePolls,
            },
            sources: item.sources.map((source) =>
              source.id === item.policy.deepVenueSource
                ? {
                    ...source,
                    capped: true,
                    executablePrice:
                      item.policy.target *
                      (1 -
                        (item.policy.criticalDeviationBps +
                          source.policy.conversionErrorBps) /
                          10_000),
                  }
                : source,
            ),
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };

    render();

    const aggregate = container.querySelector(
      '[data-testid="peg-aggregate-status"]',
    );
    expect(aggregate?.textContent).toContain("Critical condition detected");
    expect(aggregate?.parentElement?.className).toContain("border-red");
    expect(container.textContent).toContain(
      "available partial price crossed the critical downside limit",
    );
  });
  it("renders source-adjusted thresholds on the centered distance rail", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    state.current = {
      data: {
        ...response,
        packages: [
          {
            ...item,
            sources: item.sources.map((source) =>
              source.id === item.policy.deepVenueSource
                ? {
                    ...source,
                    policy: { ...source.policy, conversionErrorBps: 30 },
                    executablePrice: 0.9975,
                    deviationBps: 25,
                    premiumBps: 0,
                  }
                : source,
            ),
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };

    render();

    const rail = container.querySelector(
      '[role="img"][aria-label*="Downside warning begins at 55 bps"]',
    );
    expect(rail?.getAttribute("aria-label")).toContain(
      "downside critical at 80 bps",
    );
    expect(rail?.getAttribute("aria-label")).toContain(
      "premium warning at 55 bps",
    );
    expect(container.textContent).toContain("30 bps remaining");
    expect(
      container.querySelector('[data-testid="peg-current-europ-schuman"]')
        ?.className,
    ).toContain("bg-emerald-600");

    state.current = {
      ...state.current,
      data: {
        ...state.current.data!,
        packages: state.current.data!.packages.map((asset) => ({
          ...asset,
          sources: asset.sources.map((source) =>
            source.id === asset.policy.deepVenueSource
              ? {
                  ...source,
                  executablePrice: 0.9945,
                  deviationBps: 55,
                }
              : source,
          ),
        })),
      },
    };
    render();
    expect(
      container.querySelector('[data-testid="peg-current-europ-schuman"]')
        ?.className,
    ).toContain("bg-amber-500");
  });
  it("renders non-null listing evidence from a schema-version-1 package", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    state.current = {
      data: {
        ...response,
        packages: [
          {
            ...item,
            sources: [
              {
                ...item.sources[0]!,
                listingState: "halted",
                listingCheckedAt: PEG_FIXTURE_PRODUCED_AT - 5,
                healthy: false,
              },
            ],
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };
    render();
    expect(container.textContent).toContain("Trading halted");
    expect(container.textContent).toContain("Trading availability checked");
    expect(container.textContent).toContain("2027-01-15T07:59:55 UTC");
    expect(container.textContent).toContain("missing after 2 checks");
    expect(container.textContent).not.toMatch(/current .*streak/i);
  });
  it("renders conversion provenance only for converted sources and distinguishes monitor query saturation", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    const monitor = item.monitors[0]!;
    const conversion = item.sources.find(
      ({ convertVia }) => convertVia !== null,
    )?.convertVia;
    expect(conversion).not.toBeNull();
    state.current = {
      data: {
        ...response,
        packages: [
          {
            ...item,
            monitors: [
              { ...monitor, structuralQuerySaturated: true },
              {
                ...monitor,
                rateFeedId: "0x6666666666666666666666666666666666666666",
                structuralQuerySaturated: false,
              },
            ],
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };
    render();
    expect(container.textContent).toContain("Price conversion:");
    expect(container.textContent).toContain("USD → EUR");
    expect(container.textContent).toContain("0xec5748…c318ca");
    expect(container.textContent).toContain("chain 137");
    expect(container.textContent).toContain("Partial — result limit reached");
    expect(container.textContent).toContain("Complete within page limit");
    expect(container.textContent).toContain(
      "The pool query reached its result limit, so this safety check is incomplete.",
    );

    state.current = {
      data: {
        ...response,
        packages: [
          {
            ...item,
            sources: item.sources.map((source) => ({
              ...source,
              convertVia: null,
            })),
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };
    render();
    expect(container.textContent).not.toContain("Price conversion:");
  });
  it("prioritizes an unreachable pool over a saturated query in the safety summary", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    state.current = {
      data: {
        ...response,
        packages: [
          {
            ...item,
            structural: {
              ...item.structural,
              indexedPoolReachable: false,
              structuralQuerySaturated: true,
            },
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };

    render();
    const safety = container.querySelector(
      '[data-testid="peg-safety-checks-europ-schuman"]',
    );
    expect(safety?.textContent).toContain("Pool unavailable");
    expect(safety?.textContent).toContain(
      "The indexed pool could not be reached.",
    );
    expect(safety?.textContent).not.toContain("Check incomplete");
  });
  it("prioritizes breaker faults over a saturated monitor query while keeping pool reachability first", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    const monitor = item.monitors[0]!;
    state.current = {
      data: {
        ...response,
        packages: [
          {
            ...item,
            monitors: [
              {
                ...monitor,
                structuralQuerySaturated: true,
                breaker: { ...monitor.breaker!, enabled: false },
              },
              {
                ...monitor,
                rateFeedId: "0x6666666666666666666666666666666666666666",
                structuralQuerySaturated: true,
                breaker: { ...monitor.breaker!, status: "TRIPPED" },
              },
              {
                ...monitor,
                rateFeedId: "0x8888888888888888888888888888888888888888",
                structuralQuerySaturated: true,
                breaker: null,
              },
              {
                ...monitor,
                poolAddress: "0x7777777777777777777777777777777777777777",
                indexedPoolReachable: false,
                structuralQuerySaturated: true,
                breaker: { ...monitor.breaker!, enabled: false },
              },
            ],
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };

    render();

    const safety = container.querySelector(
      '[data-testid="peg-safety-checks-europ-schuman"]',
    );
    expect(safety?.textContent).toContain("Disabled");
    expect(safety?.textContent).toContain("Triggered");
    expect(safety?.textContent).toContain("Unavailable");
    expect(safety?.textContent).toContain("Pool unavailable");
    expect(safety?.textContent).not.toContain("Check incomplete");
  });
  it("labels a current trading-limit breach as a warning in the safety summary", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    state.current = {
      data: {
        ...response,
        packages: [
          {
            ...item,
            structural: {
              ...item.structural,
              structuralSaturation: item.policy.structuralWarnFraction,
            },
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };

    render();
    const safety = container.querySelector(
      '[data-testid="peg-safety-checks-europ-schuman"]',
    );
    expect(safety?.textContent).toContain("Inflow warning");
    expect(safety?.textContent).toContain(
      "Net pool inflow is at 80% of the active on-chain trading limit. Warn at 80%.",
    );
    expect(safety?.textContent).not.toContain("Reachable");
  });
  it("renders two monitors for one pool without duplicate React keys", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    const monitor = item.monitors[0]!;
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    state.current = {
      data: {
        ...response,
        packages: [
          {
            ...item,
            monitors: [
              monitor,
              {
                ...monitor,
                rateFeedId: "0x6666666666666666666666666666666666666666",
              },
            ],
          },
        ],
      },
      isLoading: false,
      hasError: false,
    };
    render();
    expect(
      container
        .querySelector('[data-testid="peg-technical-record"]')
        ?.querySelectorAll('a[href*="?tab=oracle"]'),
    ).toHaveLength(2);
    const errors = error.mock.calls.map((call) => call.map(String).join(" "));
    try {
      expect(
        errors.some((message) =>
          message.includes("Encountered two children with the same key"),
        ),
      ).toBe(false);
    } finally {
      error.mockRestore();
    }
  });
});
