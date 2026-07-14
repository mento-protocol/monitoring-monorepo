import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PoolLifecyclePanel } from "../pool-lifecycle-panel";
import type { Pool, VirtualPoolLifecycle } from "@/lib/types";

const mockUseGQL = vi.fn();
vi.mock("@/lib/graphql", () => ({
  useGQL: (...args: unknown[]) => mockUseGQL(...args),
}));

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    network: {
      id: "celo-mainnet",
      label: "Celo",
      chainId: 42220,
      explorerBaseUrl: "https://celoscan.io",
      tokenSymbols: {},
      addressLabels: {},
      local: false,
      testnet: false,
      hasVirtualPools: true,
      contractsNamespace: "mainnet",
      hasuraUrl: "",
      hasuraSecret: "",
    },
  }),
}));

function virtualPool(): Pool {
  return {
    id: "42220-0x6297000000000000000000000000000000000000",
    chainId: 42220,
    source: "virtual_pool_factory",
  } as unknown as Pool;
}

function deployedRow(overrides: Partial<VirtualPoolLifecycle> = {}) {
  return {
    id: "1",
    action: "DEPLOYED",
    factoryAddress: "0x0000000000000000000000000000000000000099",
    txHash:
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    blockNumber: "100",
    blockTimestamp: "1700000000",
    ...overrides,
  } as VirtualPoolLifecycle;
}

function deprecatedRow(overrides: Partial<VirtualPoolLifecycle> = {}) {
  return {
    id: "2",
    action: "DEPRECATED",
    factoryAddress: "0x0000000000000000000000000000000000000099",
    txHash:
      "0xdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdead",
    blockNumber: "200",
    blockTimestamp: "1700100000",
    ...overrides,
  } as VirtualPoolLifecycle;
}

// Extract the number of Stat cells rendered inside the panel's `<dl>` by
// counting `<dt` opens — every Stat renders exactly one `<dt>`.
function statCellCount(html: string): number {
  return (html.match(/<dt/g) ?? []).length;
}

describe("PoolLifecyclePanel", () => {
  beforeEach(() => {
    mockUseGQL.mockReset();
  });

  it("renders a 2-stat skeleton (not a bare bar) while the query is loading", () => {
    mockUseGQL.mockReturnValue({ data: undefined, isLoading: true });
    const html = renderToStaticMarkup(
      <PoolLifecyclePanel pool={virtualPool()} />,
    );
    expect(html).not.toBe("");
    const dlOpenTag = html.match(/<dl[^>]*>/)?.[0] ?? "";
    expect(dlOpenTag).toContain("grid-cols-2");
    expect(dlOpenTag).toContain("sm:grid-cols-3");
    // 2 placeholder cells, one per guaranteed-present stat (Deployed,
    // Factory).
    const labelBars = (html.match(/h-4 w-16/g) ?? []).length;
    const valueBars = (html.match(/mt-1 h-5 w-20/g) ?? []).length;
    expect(labelBars).toBe(2);
    expect(valueBars).toBe(2);
  });

  it("renders the loaded 2-stat grid with the same container classes as the skeleton", () => {
    mockUseGQL.mockReturnValue({ data: undefined, isLoading: true });
    const loadingHtml = renderToStaticMarkup(
      <PoolLifecyclePanel pool={virtualPool()} />,
    );
    mockUseGQL.mockReturnValue({
      data: { VirtualPoolLifecycle: [deployedRow()] },
      isLoading: false,
    });
    const dataHtml = renderToStaticMarkup(
      <PoolLifecyclePanel pool={virtualPool()} />,
    );
    const loadingDl = loadingHtml.match(/<dl[^>]*>/)?.[0] ?? "";
    const dataDl = dataHtml.match(/<dl[^>]*>/)?.[0] ?? "";
    expect(dataDl).toBe(loadingDl);
    // The common case (deployed only, not deprecated) also renders exactly
    // 2 stat cells — the skeleton's cell count must not drift from this.
    expect(statCellCount(dataHtml)).toBe(2);
    expect(dataHtml).toContain("Deployed");
    expect(dataHtml).toContain("Factory");
    expect(dataHtml).not.toContain("Deprecated");
  });

  it("renders a 3rd stat cell once a DEPRECATED row is appended", () => {
    mockUseGQL.mockReturnValue({
      data: { VirtualPoolLifecycle: [deployedRow(), deprecatedRow()] },
      isLoading: false,
    });
    const html = renderToStaticMarkup(
      <PoolLifecyclePanel pool={virtualPool()} />,
    );
    expect(statCellCount(html)).toBe(3);
    expect(html).toContain("Deployed");
    expect(html).toContain("Factory");
    expect(html).toContain("Deprecated");
  });

  it("renders an error message (not stuck on the skeleton) when the query fails", () => {
    mockUseGQL.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Hasura 500"),
    });
    const html = renderToStaticMarkup(
      <PoolLifecyclePanel pool={virtualPool()} />,
    );
    expect(html).toContain("Lifecycle unavailable");
    expect(html).toContain("Hasura 500");
    expect(html).not.toContain("h-4 w-16");
  });

  it("renders nothing once the query resolves with no lifecycle rows (defensive-only branch)", () => {
    mockUseGQL.mockReturnValue({
      data: { VirtualPoolLifecycle: [] },
      isLoading: false,
    });
    const html = renderToStaticMarkup(
      <PoolLifecyclePanel pool={virtualPool()} />,
    );
    expect(html).toBe("");
  });
});
