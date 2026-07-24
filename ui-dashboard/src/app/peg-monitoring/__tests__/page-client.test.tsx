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
    expect(container.textContent).toContain("Current package");
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
    expect(container.textContent).toContain("Stale — last confirmed package");
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
    expect(container.textContent).toContain("Current package");
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
    expect(container.textContent).toContain("Previous-policy fallback");
    expect(container.textContent).toContain("Unhealthy");
    const disabled = Array.from(container.querySelectorAll("span")).find(
      (element) => element.textContent === "Disabled",
    );
    expect(disabled?.className).toContain("text-red-300");
    expect(container.textContent).toContain("Breaker unavailable");
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
    expect(container.textContent).toContain("Saturated — partial-query risk");
    expect(container.textContent).toContain("Complete within page limit");

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
    expect(container.querySelectorAll('a[href*="?tab=oracle"]')).toHaveLength(
      2,
    );
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
