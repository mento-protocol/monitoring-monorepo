/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AggregatorWindowRow } from "@/lib/volume-aggregators";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("@/components/chain-icon", () => ({
  ChainIcon: () => <span data-testid="chain-icon" />,
}));

vi.mock("@/components/address-link", () => ({
  AddressLink: ({
    address,
    chainId,
  }: {
    address: string;
    chainId?: number;
  }) => (
    <a href={`mock-address://${chainId ?? "default"}/${address}`}>{address}</a>
  ),
}));

vi.mock("@/components/time-series-chart-card", () => ({
  TimeSeriesChartCard: () => <div data-testid="aggregator-chart" />,
}));

import { AggregatorBreakdownSection } from "../aggregator-breakdown-section";

const USD_WEI = BigInt(10) ** BigInt(18);

type Handle = {
  container: HTMLElement;
  root: Root;
};

function row(overrides: Partial<AggregatorWindowRow>): AggregatorWindowRow {
  return {
    chainId: 42220,
    aggregator: "squid",
    lastSeenAggregatorAddress: "0xrouter",
    swapCount: 1,
    uniqueTradersApprox: 1,
    volumeUsdWei: USD_WEI,
    ...overrides,
  };
}

function renderSection(
  props: Partial<Parameters<typeof AggregatorBreakdownSection>[0]> = {},
): Handle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <AggregatorBreakdownSection
        venueLabel="v3"
        rangeLabel="7d"
        aggregators={[]}
        isLoading={false}
        hasError={false}
        isCapHit={false}
        {...props}
      />,
    );
  });
  return { container, root };
}

function teardown(handle: Handle): void {
  act(() => {
    handle.root.unmount();
  });
  handle.container.remove();
}

function headerButton(
  container: HTMLElement,
  label: string,
): HTMLButtonElement {
  const buttons = Array.from(
    container.querySelectorAll<HTMLButtonElement>("thead button"),
  );
  const match = buttons.find((button) =>
    (button.textContent ?? "").trim().startsWith(label),
  );
  if (!match) {
    throw new Error(
      `No header button matched "${label}". Buttons: ${buttons
        .map((button) => `"${(button.textContent ?? "").trim()}"`)
        .join(", ")}`,
    );
  }
  return match;
}

function aggregatorNames(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLTableRowElement>("tbody tr"),
  ).map((tr) => (tr.children[1]?.textContent ?? "").trim());
}

describe("AggregatorBreakdownSection", () => {
  let handle: Handle | null = null;

  beforeEach(() => {
    window.history.replaceState(null, "", "/volume");
  });

  afterEach(() => {
    if (handle) {
      teardown(handle);
      handle = null;
    }
  });

  it("renders cap disclosure and cluster deployer metadata", () => {
    handle = renderSection({
      aggregators: [
        row({
          aggregator: "cluster-7dc08ec28f299c06",
          lastSeenAggregatorAddress:
            "0xf184a8498f4bad5ca6ef538b72142411588792a3",
        }),
      ],
      isCapHit: true,
    });

    expect(handle.container.textContent).toContain(
      "Approximate aggregator list.",
    );
    const clusterLink = handle.container.querySelector<HTMLAnchorElement>(
      'a[aria-label^="cluster-7dc08ec28f299c06 shared deployer"]',
    );
    expect(clusterLink?.getAttribute("href")).toBe(
      "https://celoscan.io/address/0x7dc08ec28f299c062d2941de1f9cfb741df8f022",
    );
    expect(clusterLink?.getAttribute("title")).toContain(
      "0x7dc08ec28f299c062d2941de1f9cfb741df8f022",
    );
  });

  it("keeps the v2 migration-outreach note", () => {
    handle = renderSection({ venueLabel: "v2" });

    expect(handle.container.textContent).toContain(
      "reach out to the operator about migrating to v3",
    );
  });

  it("renders v2 first-party route buckets with trader-facing labels", () => {
    handle = renderSection({
      venueLabel: "v2",
      aggregators: [
        row({ aggregator: "broker" }),
        row({ aggregator: "mento-router-v2" }),
        row({ aggregator: "mento-router-v3" }),
      ],
    });

    expect(aggregatorNames(handle.container)).toEqual([
      "Broker",
      "Mento Router v2",
      "Mento Router v3",
    ]);
  });

  it("reserves a table-shaped skeleton (header + measured row rhythm) while loading, matching the loaded table's <thead> structure", () => {
    // Without `hasExternalLoadingAnnouncer`, the skeleton announces itself
    // (role="status") — the standalone-loading case where no other element
    // on the page covers the loading state.
    handle = renderSection({ isLoading: true });
    const status = handle.container.querySelector<HTMLElement>(
      '[role="status"][aria-label="Loading table"]',
    );
    expect(status).not.toBeNull();
    const [header, body] = Array.from(status!.children) as [
      HTMLElement,
      HTMLElement,
    ];
    expect(header.style.height).toBe("36px");
    expect(body.children.length).toBeGreaterThan(0);
    Array.from(body.children).forEach((row) => {
      expect((row as HTMLElement).style.height).toBe("44px");
    });
    teardown(handle);

    handle = renderSection({
      isLoading: false,
      aggregators: [row({ aggregator: "squid" })],
    });
    expect(handle.container.querySelector("thead")).not.toBeNull();
    expect(handle.container.querySelector("tbody")).not.toBeNull();
  });

  it("silences the loading skeleton only while another announcer is active (hasExternalLoadingAnnouncer)", () => {
    // Combined loading: the venue's trader table is announcing, so this
    // section's skeleton must go presentational — no role/aria-live at all.
    handle = renderSection({
      isLoading: true,
      hasExternalLoadingAnnouncer: true,
    });
    expect(handle.container.querySelector('[role="status"]')).toBeNull();
    expect(handle.container.querySelector("[aria-live]")).toBeNull();
    // The skeleton itself still renders (36px header bar).
    const skeleton = Array.from(
      handle.container.querySelectorAll<HTMLElement>("div"),
    ).find(
      (el) =>
        (el.firstElementChild as HTMLElement | null)?.style.height === "36px",
    );
    expect(skeleton).not.toBeUndefined();
  });

  it("sorts rows through the v3 aggregator URL params", () => {
    handle = renderSection({
      aggregators: [
        row({
          aggregator: "squid",
          swapCount: 1,
          volumeUsdWei: BigInt(10) * USD_WEI,
        }),
        row({
          aggregator: "lifi",
          swapCount: 20,
          volumeUsdWei: BigInt(1) * USD_WEI,
        }),
      ],
    });

    expect(aggregatorNames(handle.container)).toEqual(["squid", "lifi"]);

    act(() => {
      headerButton(handle!.container, "Swaps").click();
    });

    expect(aggregatorNames(handle.container)).toEqual(["lifi", "squid"]);
    expect(window.location.search).toBe("?v3aggSort=swaps&v3aggDir=desc");

    act(() => {
      headerButton(handle!.container, "Swaps").click();
    });

    expect(aggregatorNames(handle.container)).toEqual(["squid", "lifi"]);
    expect(window.location.search).toBe("?v3aggSort=swaps&v3aggDir=asc");
  });
});
