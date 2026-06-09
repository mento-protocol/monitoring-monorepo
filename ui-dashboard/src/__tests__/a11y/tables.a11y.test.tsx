/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * axe-core accessibility checks for sortable tables and their empty/loading
 * states.
 *
 * The targets:
 *
 * 1. `SortableTh` — used by every sortable column in the dashboard. Must
 *    set `aria-sort="ascending" | "descending"` on the active column and
 *    `"none"` on the rest. axe's `aria-allowed-attr` / `aria-valid-attr-value`
 *    rules catch typos / missing values.
 *
 * 2. `RevenueByPoolTable` empty / error / partial-data shells — these are
 *    rendered as plain text inside a `<section>` shell. The risk: an icon-only
 *    empty state with no accessible name. axe's `region` / `landmark-one-main`
 *    rules don't fire on an isolated section, so we focus on the simpler
 *    "no violations" guarantee.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { axe } from "vitest-axe";

// `RevenueByPoolTable` calls `useTableSort` which transitively pulls in
// `useRouter` / `usePathname` / `useSearchParams` from next/navigation. The
// hooks throw "invariant expected app router to be mounted" without the App
// Router shell.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/revenue",
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/chain-icon", () => ({
  ChainIcon: () => <span data-testid="chain-icon" aria-hidden="true" />,
}));

import { SortableTh } from "@/components/sortable-th";
import { RevenueByPoolTable } from "@/components/revenue-by-pool-table";
import type { NetworkData, PoolLabel } from "@/lib/fetch-all-networks";
import type { PoolDailyFeeSnapshot } from "@/lib/types";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function render(element: React.ReactElement) {
  act(() => {
    root.render(element);
  });
}

// ---------------------------------------------------------------------------
// SortableTh — exact aria-sort wiring on the active column
// ---------------------------------------------------------------------------

describe("SortableTh aria-sort wiring", () => {
  function renderHeaderRow(activeKey: "name" | "value", dir: "asc" | "desc") {
    render(
      <table>
        <thead>
          <tr>
            <SortableTh
              sortKey="name"
              activeSortKey={activeKey}
              sortDir={dir}
              onSort={() => undefined}
            >
              Name
            </SortableTh>
            <SortableTh
              sortKey="value"
              activeSortKey={activeKey}
              sortDir={dir}
              onSort={() => undefined}
              align="right"
            >
              Value
            </SortableTh>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>row</td>
            <td>1</td>
          </tr>
        </tbody>
      </table>,
    );
  }

  it("sets aria-sort=ascending on the active column when sorted asc", async () => {
    renderHeaderRow("value", "asc");
    const headers = Array.from(container.querySelectorAll("th"));
    expect(headers[0]!.getAttribute("aria-sort")).toBe("none");
    expect(headers[1]!.getAttribute("aria-sort")).toBe("ascending");
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("sets aria-sort=descending on the active column when sorted desc", async () => {
    renderHeaderRow("name", "desc");
    const headers = Array.from(container.querySelectorAll("th"));
    expect(headers[0]!.getAttribute("aria-sort")).toBe("descending");
    expect(headers[1]!.getAttribute("aria-sort")).toBe("none");
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RevenueByPoolTable empty + error states
// ---------------------------------------------------------------------------

const POOL_ADDR = "0xaaaa000000000000000000000000000000000001";
const CHAIN = 42220;
const SECS_PER_DAY = 86_400;
const NOW_S = Math.floor(Date.now() / 1000);
const TODAY_BUCKET = String(Math.floor(NOW_S / SECS_PER_DAY) * SECS_PER_DAY);

function feeSnapshot(
  overrides: Partial<PoolDailyFeeSnapshot> = {},
): PoolDailyFeeSnapshot {
  const dayTs = overrides.timestamp ?? TODAY_BUCKET;
  const poolAddress = overrides.poolAddress ?? POOL_ADDR;
  return {
    id: `${CHAIN}-${poolAddress}-${dayTs}`,
    chainId: CHAIN,
    poolAddress,
    timestamp: dayTs,
    tokens: ["0xusd"],
    tokenSymbols: ["USDm"],
    tokenDecimals: [18],
    amounts: ["1000000000000000000"],
    feesUsdWei: "1000000000000000000",
    ...overrides,
  };
}

function networkData(snapshots: PoolDailyFeeSnapshot[]): NetworkData {
  return {
    network: {
      id: "celo-mainnet",
      chainId: CHAIN,
      label: "Celo",
      contractsNamespace: null,
      hasuraUrl: "",
      hasuraSecret: "",
      explorerBaseUrl: "https://celoscan.io",
      tokenSymbols: {},
      addressLabels: {},
      local: false,
      testnet: false,
      hasVirtualPools: false,
    },
    snapshotWindows: {
      w24h: { from: 0, to: 0 },
      w7d: { from: 0, to: 0 },
      w30d: { from: 0, to: 0 },
    },
    pools: [],
    snapshots: [],
    snapshots7d: [],
    snapshots30d: [],
    snapshotsAllDaily: [],
    snapshotsAllDailyTruncated: false,
    brokerSnapshotsAllDaily: [],
    brokerSnapshotsAllDailyTruncated: false,
    olsPoolIds: new Set(),
    cdpPoolIds: new Set(),
    reservePoolIds: new Set(),
    strategyError: null,
    fees: null,
    feeSnapshots: snapshots,
    feeSnapshotsError: null,
    feeSnapshotsTruncated: false,
    ratesError: null,
    poolLabels: new Map(),
    uniqueLpAddresses: null,
    rates: new Map([
      ["USDm", 1],
      ["GBPm", 1.3263],
    ]),
    error: null,
    snapshotsError: null,
    snapshots7dError: null,
    snapshots30dError: null,
    snapshotsAllDailyError: null,
    brokerSnapshotsAllDailyError: null,
    lpError: null,
  };
}

function poolLabel(poolAddress: string): PoolLabel {
  return {
    id: `${CHAIN}-${poolAddress}`,
    token0: "0xusd",
    token1: "0xgbp",
    source: "fpmm_factory",
  };
}

describe("RevenueByPoolTable a11y — degraded states", () => {
  it("loading shell has no axe violations", async () => {
    render(
      <RevenueByPoolTable
        networkData={[networkData([])]}
        isLoading={true}
        hasError={false}
      />,
    );
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("empty (no data) shell has no axe violations and shows a real message", async () => {
    render(
      <RevenueByPoolTable
        networkData={[networkData([])]}
        isLoading={false}
        hasError={false}
      />,
    );
    expect(container.textContent).toContain("No swap-fee transfers indexed");
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("all-pools zero-fee table has no axe violations", async () => {
    const n = networkData([]);
    n.poolLabels = new Map([[POOL_ADDR, poolLabel(POOL_ADDR)]]);
    render(
      <RevenueByPoolTable
        networkData={[n]}
        isLoading={false}
        hasError={false}
      />,
    );
    expect(container.textContent).toContain("$0.00");
    expect(container.textContent).not.toContain(
      "No swap-fee transfers indexed",
    );
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("error shell (couldn't load) has no axe violations", async () => {
    const n = networkData([feeSnapshot()]);
    n.ratesError = new Error("oracle rates timed out");
    render(
      <RevenueByPoolTable
        networkData={[n]}
        isLoading={false}
        hasError={true}
      />,
    );
    expect(container.textContent).toContain("Couldn't load per-pool revenue");
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("populated table renders a real <table> with the right column count and passes axe", async () => {
    render(
      <RevenueByPoolTable
        networkData={[networkData([feeSnapshot()])]}
        isLoading={false}
        hasError={false}
      />,
    );
    // Real <table>, not a div-grid — confirms screen readers can navigate it
    // as tabular data.
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    // Header row has Pool + 4 fee columns = 5 SortableTh.
    const headers = container.querySelectorAll("th[aria-sort]");
    expect(headers.length).toBe(5);
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("partial-data shell (some chains errored, others have rows) renders the warning + table together", async () => {
    // Production scenario: one chain's fee query failed but others
    // succeeded. The page passes `hasError={true}` (because at least
    // one chain hit an error) AND has surviving rows from the
    // healthy chains. The warning banner above the table is the
    // signal to the user — Cursor flagged this branch as
    // a11y-untested in PR #342 review.
    const healthyChain = networkData([feeSnapshot()]);
    const erroredChain = networkData([]);
    erroredChain.feeSnapshotsError = new Error("rate limited");
    render(
      <RevenueByPoolTable
        networkData={[healthyChain, erroredChain]}
        isLoading={false}
        hasError={true}
      />,
    );
    // Warning banner is present.
    expect(container.textContent).toContain(
      "One or more chains failed to load — showing partial data",
    );
    // Surviving rows still render in a real <table>.
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(container.querySelectorAll("th[aria-sort]").length).toBe(5);
    // The empty-error shell text must NOT appear — that's a different branch.
    expect(container.textContent).not.toContain(
      "Couldn't load per-pool revenue",
    );
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
