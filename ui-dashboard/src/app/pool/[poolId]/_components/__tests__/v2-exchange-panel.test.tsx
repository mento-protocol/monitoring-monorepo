import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { V2ExchangePanel } from "../v2-exchange-panel";
import type { Network } from "@/lib/networks";
import type { BiPoolExchangeRow, Pool } from "@/lib/types";

vi.mock("@/components/address-link", () => ({
  AddressLink: ({ address }: { address: string }) => <span>{address}</span>,
}));

vi.mock("@/components/tooltip", () => ({
  Tooltip: () => null,
}));

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function pool(): Pool {
  return {
    id: "42220-0x6297000000000000000000000000000000000000",
    chainId: 42220,
    token0: "0x0000000000000000000000000000000000000010",
    token1: "0x0000000000000000000000000000000000000020",
    token0Decimals: 18,
    token1Decimals: 18,
    source: "virtual_pool_factory",
  } as unknown as Pool;
}

function network(): Network {
  return {
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
  } as unknown as Network;
}

function v2Config(
  overrides: Partial<BiPoolExchangeRow> = {},
): BiPoolExchangeRow {
  return {
    id: "1",
    chainId: 42220,
    exchangeId: "0x6297000000000000000000000000000000000000000000000000000000",
    exchangeProvider: "0x0000000000000000000000000000000000000030",
    asset0: "0x0000000000000000000000000000000000000010",
    asset1: "0x0000000000000000000000000000000000000020",
    pricingModule: "0x0000000000000000000000000000000000000040",
    pricingModuleName: "ConstantSum",
    spread: "5000000000000000000000", // 0.5% = 50bps
    referenceRateFeedID: "0x0000000000000000000000000000000000000050",
    referenceRateResetFrequency: "300",
    minimumReports: "1",
    stablePoolResetSize: "0",
    bucket0: "1000000000000000000000",
    bucket1: "1000000000000000000000",
    lastBucketUpdate: "1700000000",
    isDeprecated: false,
    wrappedByPoolId: pool().id,
    ...overrides,
  };
}

// Extract the number of Stat cells rendered inside the panel's `<dl>` by
// counting `<dt` opens — every Stat renders exactly one `<dt>`.
function statCellCount(html: string): number {
  return (html.match(/<dt/g) ?? []).length;
}

describe("V2ExchangePanel", () => {
  it("renders a 9-stat skeleton (not a bare bar) while the query is loading", () => {
    const html = renderToStaticMarkup(
      <V2ExchangePanel
        pool={pool()}
        network={network()}
        v2Config={null}
        isLoading
      />,
    );
    expect(html).not.toBe("");
    // Same grid container classes as the loaded `<dl>` below.
    const dlOpenTag = html.match(/<dl[^>]*>/)?.[0] ?? "";
    expect(dlOpenTag).toContain("grid-cols-2");
    expect(dlOpenTag).toContain("sm:grid-cols-3");
    expect(dlOpenTag).toContain("lg:grid-cols-5");
    // 9 placeholder cells, one per real stat (Swap Fee, Pricing Curve,
    // Bucket Reset, 2× Bucket, Last Reset, Oracle Feed, Exchange ID,
    // BiPoolManager).
    const labelBars = (html.match(/h-4 w-20/g) ?? []).length;
    const valueBars = (html.match(/mt-1 h-5 w-24/g) ?? []).length;
    expect(labelBars).toBe(9);
    expect(valueBars).toBe(9);
  });

  it("renders the loaded 9-stat grid with the same container classes as the skeleton", () => {
    const loadingHtml = renderToStaticMarkup(
      <V2ExchangePanel
        pool={pool()}
        network={network()}
        v2Config={null}
        isLoading
      />,
    );
    const dataHtml = renderToStaticMarkup(
      <V2ExchangePanel
        pool={pool()}
        network={network()}
        v2Config={v2Config()}
        isLoading={false}
      />,
    );
    const loadingDl = loadingHtml.match(/<dl[^>]*>/)?.[0] ?? "";
    const dataDl = dataHtml.match(/<dl[^>]*>/)?.[0] ?? "";
    expect(dataDl).toBe(loadingDl);
    // Real content also renders exactly 9 stat cells — the skeleton's cell
    // count must not drift from this.
    expect(statCellCount(dataHtml)).toBe(9);
    expect(dataHtml).toContain("50 bps");
    expect(dataHtml).toContain("ConstantSum");
    expect(dataHtml).toContain("Exchange ID");
    expect(dataHtml).toContain("BiPoolManager");
  });

  it("renders the syncing note (not stuck on the skeleton) once the query resolves with no joined row", () => {
    const html = renderToStaticMarkup(
      <V2ExchangePanel
        pool={pool()}
        network={network()}
        v2Config={null}
        isLoading={false}
      />,
    );
    expect(html).toContain("v2 exchange data syncing");
    expect(html).not.toContain("h-4 w-20");
  });

  it("renders the syncing note for the zero-feed stub sentinel", () => {
    const html = renderToStaticMarkup(
      <V2ExchangePanel
        pool={pool()}
        network={network()}
        v2Config={v2Config({ referenceRateFeedID: ZERO_ADDRESS })}
        isLoading={false}
      />,
    );
    expect(html).toContain("v2 exchange data syncing");
  });

  it("renders the error note (not stuck on the skeleton) when the query fails", () => {
    const html = renderToStaticMarkup(
      <V2ExchangePanel
        pool={pool()}
        network={network()}
        v2Config={null}
        isLoading={false}
        hasError
      />,
    );
    expect(html).toContain("v2 exchange config unavailable");
    expect(html).not.toContain("h-4 w-20");
  });

  it("renders the deprecated governance-removal note", () => {
    const html = renderToStaticMarkup(
      <V2ExchangePanel
        pool={pool()}
        network={network()}
        v2Config={v2Config({ isDeprecated: true })}
        isLoading={false}
      />,
    );
    expect(html).toContain("v2 exchange deprecated");
    expect(html).toContain("removed by governance");
  });
});
