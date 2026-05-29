/**
 * Smoke tests for the URL-driven sort wiring on `RevenueByPoolTable`. Covers
 * the integration gap that `useTableSort`'s unit tests can't see — wrong
 * `paramPrefix` / wrong `defaultKey` would silently break URL persistence
 * without these tests catching it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NetworkData } from "@/lib/fetch-all-networks";
import type { PoolDailyFeeSnapshot } from "@/lib/types";

let mockSearchParams = new URLSearchParams();
const mockReplace = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: mockReplace }),
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
  ChainIcon: () => <span data-testid="chain-icon" />,
}));

import { RevenueByPoolTable } from "@/components/revenue-by-pool-table";

const POOL_ADDR = "0xaaaa000000000000000000000000000000000001";
const CHAIN = 42220;
const SECS_PER_DAY = 86_400;
const TODAY_BUCKET = String(
  Math.floor(Math.floor(Date.now() / 1000) / SECS_PER_DAY) * SECS_PER_DAY,
);

function feeSnapshot(): PoolDailyFeeSnapshot {
  return {
    id: `${CHAIN}-${POOL_ADDR}-${TODAY_BUCKET}`,
    chainId: CHAIN,
    poolAddress: POOL_ADDR,
    timestamp: TODAY_BUCKET,
    tokens: ["0xusd"],
    tokenSymbols: ["USDm"],
    tokenDecimals: [18],
    amounts: ["1000000000000000000"],
    feesUsdWei: "1000000000000000000",
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
    tradingLimits: [],
    olsPoolIds: new Set(),
    cdpPoolIds: new Set(),
    reservePoolIds: new Set(),
    fees: null,
    feeSnapshots: snapshots,
    feeSnapshotsError: null,
    feeSnapshotsTruncated: false,
    ratesError: null,
    poolLabels: new Map(),
    uniqueLpAddresses: null,
    rates: new Map([["USDm", 1]]),
    error: null,
    snapshotsError: null,
    snapshots7dError: null,
    snapshots30dError: null,
    snapshotsAllDailyError: null,
    brokerSnapshotsAllDailyError: null,
    lpError: null,
  };
}

beforeEach(() => {
  mockSearchParams = new URLSearchParams();
  mockReplace.mockClear();
});

/**
 * Extracts an `{ "label" → "aria-sort value" }` map from the rendered HTML by
 * splitting on `</th>` and matching each segment's aria-sort attribute and
 * inner button text. Less fragile than a backtracking regex that can span
 * multiple `<th>` elements.
 */
function ariaSortByLabel(html: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const seg of html.split("</th>")) {
    const sort = seg.match(/aria-sort="([^"]+)"/);
    const label = seg.match(/<button[^>]*>([^<]+)/);
    if (sort && label) result[label[1]!.trim()] = sort[1]!;
  }
  return result;
}

function render(): Record<string, string> {
  const html = renderToStaticMarkup(
    <RevenueByPoolTable
      networkData={[networkData([feeSnapshot()])]}
      isLoading={false}
      hasError={false}
    />,
  );
  return ariaSortByLabel(html);
}

describe("RevenueByPoolTable — URL-driven sort wiring", () => {
  it("aria-sort on the active header matches the URL state", () => {
    mockSearchParams = new URLSearchParams(
      "leaderboardSort=fees24h&leaderboardDir=asc",
    );
    const sort = render();
    expect(sort["24h"]).toBe("ascending");
    expect(sort["7d"]).toBe("none");
    expect(sort["30d"]).toBe("none");
    expect(sort["All-time"]).toBe("none");
  });

  it("falls back to defaultKey/defaultDir aria-sort when URL is empty", () => {
    mockSearchParams = new URLSearchParams();
    const sort = render();
    expect(sort["7d"]).toBe("descending");
    expect(sort["24h"]).toBe("none");
  });

  it("uses the leaderboard prefix (not pools) — wrong prefix would break this", () => {
    mockSearchParams = new URLSearchParams("poolsSort=fees24h&poolsDir=asc");
    const sort = render();
    expect(sort["7d"]).toBe("descending");
    expect(sort["24h"]).toBe("none");
  });
});
