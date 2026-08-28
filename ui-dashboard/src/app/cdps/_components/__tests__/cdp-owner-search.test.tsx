/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CdpCollateral } from "../../_lib/types";
import {
  CDP_OWNER_SEARCH_REQUEST_LIMIT,
  type CdpOwnerTroveRow,
} from "../../_lib/owner-search";

const mockUseGQL = vi.hoisted(() => vi.fn());
const mockSearchParams = vi.hoisted(() => ({
  current: new URLSearchParams(),
}));

vi.mock("@/lib/graphql", () => ({
  HASURA_TIMEOUT_MS: 5000,
  useGQL: (...args: unknown[]) => mockUseGQL(...args),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams.current,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { CDP_TROVES_BY_OWNER } from "@/lib/queries";
import { CdpOwnerSearch } from "../cdp-owner-search";

const NOW = 1_767_225_600;
const OWNER = "0xcca0a99b94529493ddffe7c61a3ae454828cd3bb";
const USD_WEI = BigInt(10) ** BigInt(18);

function wei(amount: number): string {
  return (BigInt(amount) * USD_WEI).toString();
}

function collateral(overrides: Partial<CdpCollateral>): CdpCollateral {
  return {
    id: "42220-0xgbpm",
    chainId: 42220,
    collIndex: 0,
    symbol: "GBPm",
    debtToken: "0xdebt",
    collToken: "0xcoll",
    troveManager: "0xtrove",
    stabilityPool: "0xstability",
    minDebt: wei(100),
    minBoldInSp: wei(1),
    minBoldAfterRebalance: wei(5_000),
    systemParamsLoaded: true,
    mcrBps: 11_000,
    ccrBps: 15_000,
    scrBps: 11_000,
    ...overrides,
  };
}

const COLLATERALS = [
  collateral({}),
  collateral({ id: "42220-0xchfm", collIndex: 1, symbol: "CHFm" }),
];

function ownerHit(overrides: Partial<CdpOwnerTroveRow> = {}): CdpOwnerTroveRow {
  return {
    id: "42220-0xgbpm-0x1",
    collateralId: "42220-0xgbpm",
    troveId: "0x1",
    status: "active",
    debt: wei(25_000),
    coll: wei(40_000),
    lastUpdatedAt: String(NOW - 3_600),
    ...overrides,
  };
}

type GqlState = {
  data: { Trove: CdpOwnerTroveRow[] } | undefined;
  error: Error | null;
  isLoading: boolean;
};

function mockOwnerQuery(state: GqlState) {
  mockUseGQL.mockImplementation((query: string | null) =>
    query === CDP_TROVES_BY_OWNER
      ? state
      : { data: undefined, error: null, isLoading: false },
  );
}

type Handle = { container: HTMLElement; root: Root };

function setup(): Handle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { container, root: createRoot(container) };
}

function render(handle: Handle, node: React.ReactNode) {
  act(() => {
    handle.root.render(<>{node}</>);
  });
}

function teardown(handle: Handle | null) {
  if (!handle) return;
  act(() => {
    handle.root.unmount();
  });
  handle.container.remove();
}

function setUrl(url: string) {
  window.history.replaceState(window.history.state, "", url);
  mockSearchParams.current = new URLSearchParams(window.location.search);
}

function ownerInput(handle: Handle): HTMLInputElement {
  const input = handle.container.querySelector<HTMLInputElement>(
    'input[aria-label="Find troves by owner address"]',
  );
  if (!input) throw new Error("Missing owner search input");
  return input;
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function firedOwnerQueries(): unknown[][] {
  return mockUseGQL.mock.calls.filter(
    ([query]) => query === CDP_TROVES_BY_OWNER,
  );
}

describe("CdpOwnerSearch", () => {
  let handle: Handle | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    vi.clearAllMocks();
    setUrl("/cdps");
    mockOwnerQuery({ data: undefined, error: null, isLoading: false });
    handle = setup();
  });

  afterEach(() => {
    teardown(handle);
    handle = null;
    vi.useRealTimers();
  });

  it("fires no query and shows no status while idle", () => {
    render(
      handle!,
      <CdpOwnerSearch collaterals={COLLATERALS} chainId={42220} />,
    );

    expect(firedOwnerQueries()).toHaveLength(0);
    expect(handle!.container.querySelector('[role="status"]')).toBeNull();
    expect(handle!.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("flags an invalid address honestly and never fires the query", () => {
    render(
      handle!,
      <CdpOwnerSearch collaterals={COLLATERALS} chainId={42220} />,
    );

    act(() => {
      typeInto(ownerInput(handle!), "0xnothex");
    });

    const status = handle!.container.querySelector('[role="status"]');
    expect(status?.textContent).toContain("Not a valid address");
    expect(firedOwnerQueries()).toHaveLength(0);
  });

  it("initializes from ?owner=, normalizes it, and fires the sentinel-sized query", () => {
    setUrl(`/cdps?owner=${OWNER.toUpperCase().replace("0X", "0x")}`);
    mockOwnerQuery({
      data: { Trove: [ownerHit()] },
      error: null,
      isLoading: false,
    });

    render(
      handle!,
      <CdpOwnerSearch collaterals={COLLATERALS} chainId={42220} />,
    );

    expect(ownerInput(handle!).value).toBe(OWNER);
    const call = mockUseGQL.mock.calls.find(
      ([query]) => query === CDP_TROVES_BY_OWNER,
    );
    expect(call?.[1]).toEqual({
      chainId: 42220,
      address: OWNER,
      limit: CDP_OWNER_SEARCH_REQUEST_LIMIT,
    });
    expect(call?.[2]).toMatchObject({ timeoutMs: 5000 });
    // Canonicalized on mount: the mixed-case param is rewritten lowercase.
    expect(window.location.search).toBe(`?owner=${OWNER}`);
  });

  it("links each hit to its market-scoped history page with status and market", () => {
    setUrl(`/cdps?owner=${OWNER}`);
    mockOwnerQuery({
      data: {
        Trove: [
          ownerHit(),
          ownerHit({
            id: "42220-0xchfm-0x2b",
            collateralId: "42220-0xchfm",
            troveId: "0x2b",
            status: "liquidated",
            debt: wei(500),
            coll: wei(0),
          }),
        ],
      },
      error: null,
      isLoading: false,
    });

    render(
      handle!,
      <CdpOwnerSearch collaterals={COLLATERALS} chainId={42220} />,
    );

    const table = handle!.container.querySelector(
      'table[aria-label="Troves by owner"]',
    );
    expect(table).not.toBeNull();
    const gbpLink = handle!.container.querySelector<HTMLAnchorElement>(
      'a[href="/cdps/gbpm/troves/0x1"]',
    );
    expect(gbpLink).not.toBeNull();
    expect(gbpLink?.getAttribute("aria-label")).toBe(
      "View history for trove 0x1",
    );
    expect(
      handle!.container.querySelector('a[href="/cdps/chfm/troves/0x2b"]'),
    ).not.toBeNull();
    // Closed/liquidated troves link through from day one, with status and
    // market visible per hit.
    expect(table?.textContent).toContain("liquidated");
    expect(table?.textContent).toContain("GBPm");
    expect(table?.textContent).toContain("CHFm");
    // Debt renders in the hit's own market token, collateral in USDm.
    expect(table?.textContent).toContain("25,000.00 GBPm");
    expect(table?.textContent).toContain("40,000.00 USDm");
  });

  it("renders a hit from an unknown market honestly, without a dead link", () => {
    setUrl(`/cdps?owner=${OWNER}`);
    mockOwnerQuery({
      data: {
        Trove: [
          ownerHit({
            id: "42220-0xother-0x9",
            collateralId: "42220-0xother",
            troveId: "0x9",
          }),
        ],
      },
      error: null,
      isLoading: false,
    });

    render(
      handle!,
      <CdpOwnerSearch collaterals={COLLATERALS} chainId={42220} />,
    );

    expect(
      handle!.container.querySelector('a[href*="/troves/0x9"]'),
    ).toBeNull();
    expect(handle!.container.textContent).toContain("42220-0xother");
  });

  it("discloses a capped result instead of silently shortening the list", () => {
    setUrl(`/cdps?owner=${OWNER}`);
    const rows = Array.from(
      { length: CDP_OWNER_SEARCH_REQUEST_LIMIT },
      (_, i) =>
        ownerHit({
          id: `42220-0xgbpm-0x${(i + 1).toString(16)}`,
          troveId: `0x${(i + 1).toString(16)}`,
        }),
    );
    mockOwnerQuery({ data: { Trove: rows }, error: null, isLoading: false });

    render(
      handle!,
      <CdpOwnerSearch collaterals={COLLATERALS} chainId={42220} />,
    );

    expect(handle!.container.querySelectorAll("tbody tr")).toHaveLength(
      CDP_OWNER_SEARCH_REQUEST_LIMIT - 1,
    );
    const capNotice = Array.from(
      handle!.container.querySelectorAll('[role="status"]'),
    ).find((node) => node.textContent?.includes("Results capped"));
    expect(capNotice).toBeDefined();
  });

  it("shows an honest empty state for an address with no troves", () => {
    setUrl(`/cdps?owner=${OWNER}`);
    mockOwnerQuery({ data: { Trove: [] }, error: null, isLoading: false });

    render(
      handle!,
      <CdpOwnerSearch collaterals={COLLATERALS} chainId={42220} />,
    );

    expect(handle!.container.textContent).toContain(
      "No troves indexed for this address.",
    );
  });

  it("distinguishes loading from empty, and waits for market metadata", () => {
    setUrl(`/cdps?owner=${OWNER}`);
    mockOwnerQuery({ data: undefined, error: null, isLoading: true });
    render(
      handle!,
      <CdpOwnerSearch collaterals={COLLATERALS} chainId={42220} />,
    );
    expect(
      handle!.container.querySelector('[aria-label="Loading table"]'),
    ).not.toBeNull();
    expect(handle!.container.textContent).not.toContain(
      "No troves indexed for this address.",
    );

    // Trove data ready but CDP_MARKETS still loading: still the skeleton —
    // never a flash of unlinkable "unknown market" rows.
    mockOwnerQuery({
      data: { Trove: [ownerHit()] },
      error: null,
      isLoading: false,
    });
    render(handle!, <CdpOwnerSearch collaterals={undefined} chainId={42220} />);
    expect(
      handle!.container.querySelector('[aria-label="Loading table"]'),
    ).not.toBeNull();
    expect(handle!.container.querySelector("table")).toBeNull();
  });

  it("renders a first-load failure as an alert and a refresh failure as stale", () => {
    setUrl(`/cdps?owner=${OWNER}`);
    mockOwnerQuery({
      data: undefined,
      error: new Error("downstream unavailable"),
      isLoading: false,
    });
    render(
      handle!,
      <CdpOwnerSearch collaterals={COLLATERALS} chainId={42220} />,
    );
    expect(
      handle!.container.querySelector('[role="alert"]')?.textContent,
    ).toContain("Owner search failed — downstream unavailable");

    mockOwnerQuery({
      data: { Trove: [ownerHit()] },
      error: new Error("rate limited"),
      isLoading: false,
    });
    render(
      handle!,
      <CdpOwnerSearch collaterals={COLLATERALS} chainId={42220} />,
    );
    expect(handle!.container.textContent).toContain(
      "Owner search refresh failed — showing the last confirmed state",
    );
    expect(
      handle!.container.querySelector('a[href="/cdps/gbpm/troves/0x1"]'),
    ).not.toBeNull();
  });

  it("writes ?owner= while preserving sibling params, and clears it with the input", () => {
    setUrl("/cdps?type=troveOpen&foo=1");

    render(
      handle!,
      <CdpOwnerSearch collaterals={COLLATERALS} chainId={42220} />,
    );

    act(() => {
      typeInto(
        ownerInput(handle!),
        ` ${OWNER.toUpperCase().replace("0X", "0x")} `,
      );
    });
    expect(window.location.search).toBe(`?type=troveOpen&foo=1&owner=${OWNER}`);

    act(() => {
      typeInto(ownerInput(handle!), "");
    });
    expect(window.location.search).toBe("?type=troveOpen&foo=1");
  });

  it("syncs from browser back-forward popstate", () => {
    setUrl(`/cdps?owner=${OWNER}`);
    render(
      handle!,
      <CdpOwnerSearch collaterals={COLLATERALS} chainId={42220} />,
    );
    expect(ownerInput(handle!).value).toBe(OWNER);

    window.history.replaceState(window.history.state, "", "/cdps");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(ownerInput(handle!).value).toBe("");
  });
});
