import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IntegrationProbesTable } from "../_components/integration-probes-table";
import type { IntegrationProbeSnapshot } from "@/lib/integration-probes";

describe("IntegrationProbesTable", () => {
  it("renders pass, needs-key, unsupported, and pair evidence states", () => {
    const html = renderToStaticMarkup(
      <IntegrationProbesTable snapshot={fixtureSnapshot()} />,
    );

    expect(html).toContain("OpenOcean");
    expect(html).toContain("$327.9M 30d");
    expect(html).toContain("DEX agg · DefiLlama");
    expect(html).toContain("Pass");
    expect(html).toContain("Partial");
    expect(html).toContain("Needs key");
    expect(html).toContain("Unsupported");
    expect(html).toContain("router-address");
    expect(html).toContain("EURm -&gt; USDm");
    expect(html).toContain("HTTP 200");
    expect(html).toContain("variant default");
    expect(html).toContain("amount 1");
    expect(html).toContain("3 attempts");
  });

  it("shows non-pass pair evidence before capped passing rows", () => {
    const snapshot = fixtureSnapshot();
    const chain = snapshot.aggregators[0]?.chains[0];
    if (!chain) throw new Error("missing chain fixture");
    chain.pairs = [
      ...Array.from({ length: 12 }, (_, index) =>
        pairFixture({
          chainId: chain.chainId,
          poolId: `${chain.chainId}-0xpass${index}`,
          status: "pass",
          sellSymbol: `PASS${index}`,
          error: null,
        }),
      ),
      pairFixture({
        chainId: chain.chainId,
        poolId: `${chain.chainId}-0xfail`,
        status: "fail",
        sellSymbol: "FAILINGm",
        error: "missing router evidence",
      }),
    ];

    const html = renderToStaticMarkup(
      <IntegrationProbesTable snapshot={snapshot} />,
    );

    expect(html).toContain("FAILINGm -&gt; USDm");
    expect(html).toContain("no Mento v3 router/pool address evidence");
    expect(html).toContain("1 more route checks in the snapshot.");
  });

  it("explains strict address-evidence failures with the selected venue", () => {
    const snapshot = fixtureSnapshot();
    const chain = snapshot.aggregators[0]?.chains[0];
    if (!chain) throw new Error("missing chain fixture");
    chain.status = "fail";
    chain.pairCoverage = { passed: 0, total: 1 };
    chain.pairs = [
      pairFixture({
        chainId: chain.chainId,
        poolId: `${chain.chainId}-0xfail`,
        status: "fail",
        sellSymbol: "CHFm",
        error: null,
        sourceLabels: ["Mento Dollar", "Mento Swiss Franc"],
        downstreamProvider: "Mento Swiss Franc",
        txTarget: "0x5615cdab10dc425a742d643d949a7f474c01abc4",
        responsePreview:
          '{"route":{"estimate":{"actions":[{"data":{"dex":"Uniswap V3","target":"0x5615CDAb10dc425a742d643d949a7F474C01abc4"}}]}}}',
      }),
    ];

    const html = renderToStaticMarkup(
      <IntegrationProbesTable snapshot={snapshot} />,
    );

    expect(html).toContain("CHFm -&gt; USDm");
    expect(html).toContain("no Mento v3 router/pool address evidence");
    expect(html).toContain("selected venue: Uniswap V3");
    expect(html).toContain("venue Uniswap V3");
    expect(html).toContain(
      "tx target: 0x5615cdab10dc425a742d643d949a7f474c01abc4",
    );
    expect(html).not.toContain("provider Mento Swiss Franc");
  });

  it("prioritizes preview venue keys and ignores source-only labels", () => {
    const snapshot = fixtureSnapshot();
    const chain = snapshot.aggregators[0]?.chains[0];
    if (!chain) throw new Error("missing chain fixture");
    chain.status = "fail";
    chain.pairCoverage = { passed: 0, total: 3 };
    chain.pairs = [
      pairFixture({
        chainId: chain.chainId,
        poolId: `${chain.chainId}-0xpriority`,
        status: "fail",
        sellSymbol: "CHFm",
        error: null,
        sourceLabels: ["Mento Swiss Franc"],
        downstreamProvider: "Mento Swiss Franc",
        responsePreview:
          '{"provider":"Mento Swiss Franc","protocol":"Other","dex":"Uniswap V3"}',
      }),
      pairFixture({
        chainId: chain.chainId,
        poolId: `${chain.chainId}-0xlabel`,
        status: "fail",
        sellSymbol: "EURm",
        error: null,
        sourceLabels: ["Mento Euro"],
        downstreamProvider: "Mento Euro",
        responsePreview: '{"protocol":"Mento Euro"}',
      }),
      pairFixture({
        chainId: chain.chainId,
        poolId: `${chain.chainId}-0xprovider`,
        status: "fail",
        sellSymbol: "GBPm",
        error: null,
        downstreamProvider: "Uniswap V3",
        responsePreview: '{"dex":"Other DEX"}',
      }),
    ];

    const html = renderToStaticMarkup(
      <IntegrationProbesTable snapshot={snapshot} />,
    );

    expect(html).toContain("selected venue: Uniswap V3");
    expect(html).toContain("venue Uniswap V3");
    expect(html).not.toContain("selected venue: Mento Euro");
    expect(html).not.toContain("venue Mento Euro");
    expect(html).not.toContain("selected venue: Other DEX");
    expect(html).not.toContain("venue Other DEX");
  });
});

function fixtureSnapshot(): IntegrationProbeSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-06-01T00:00:00.000Z",
    amountUsd: "1",
    takerAddress: "0x000000000000000000000000000000000000dEaD",
    pairSource: {
      kind: "hasura",
      hasuraUrlConfigured: true,
      note: "fixture",
    },
    chains: [],
    aggregators: [
      {
        id: "openocean",
        label: "OpenOcean",
        kind: "dex",
        tier: 2,
        volumeSignal: {
          window: "30d",
          category: "dex-aggregator",
          valueUsd: 327_881_227,
          sourceLabel: "DefiLlama DEX aggregators",
          sourceUrl: "https://defillama.com/protocols/dex-aggregators",
          sourceProtocol: "OpenOcean",
          note: null,
        },
        credentialEnv: [],
        researchNote: "fixture",
        chains: [
          partialChainFixture(42220, "Celo"),
          chainFixture(143, "Monad", "needs_key"),
        ],
      },
      {
        id: "cow-swap",
        label: "CoW Swap",
        kind: "excluded",
        tier: 3,
        volumeSignal: null,
        credentialEnv: [],
        researchNote: "fixture",
        chains: [
          chainFixture(42220, "Celo", "unsupported"),
          chainFixture(143, "Monad", "unsupported"),
        ],
      },
    ],
    summary: {
      aggregators: 2,
      chainChecks: 4,
      passingChainChecks: 0,
      partialChainChecks: 1,
      failingChainChecks: 0,
      needsKeyChainChecks: 1,
      unsupportedChainChecks: 2,
    },
  };
}

function chainFixture(
  chainId: number,
  chainLabel: string,
  status: "pass" | "needs_key" | "unsupported",
): IntegrationProbeSnapshot["aggregators"][number]["chains"][number] {
  const passing = status === "pass";
  return {
    chainId,
    chainSlug: chainLabel.toLowerCase(),
    chainLabel,
    status,
    pairCoverage: { passed: passing ? 1 : 0, total: 1 },
    blockingReason: passing ? null : "fixture",
    nextStep: passing ? null : "fixture next step",
    pairs: [
      pairFixture({
        chainId,
        poolId: `${chainId}-0xpool`,
        status,
        sellSymbol: "EURm",
        error: passing ? null : "fixture",
      }),
    ],
  };
}

function partialChainFixture(
  chainId: number,
  chainLabel: string,
): IntegrationProbeSnapshot["aggregators"][number]["chains"][number] {
  return {
    chainId,
    chainSlug: chainLabel.toLowerCase().replace(" ", "-"),
    chainLabel,
    status: "partial",
    pairCoverage: { passed: 1, total: 2 },
    blockingReason: "fixture partial",
    nextStep: "inspect failing route",
    pairs: [
      pairFixture({
        chainId,
        poolId: `${chainId}-0xpartialpass`,
        status: "pass",
        sellSymbol: "CHFm",
        error: null,
      }),
      pairFixture({
        chainId,
        poolId: `${chainId}-0xpartialfail`,
        status: "fail",
        sellSymbol: "GBPm",
        error: "missing evidence",
      }),
    ],
  };
}

function pairFixture({
  chainId,
  poolId,
  status,
  sellSymbol,
  error,
  sourceLabels = [],
  downstreamProvider = null,
  txTarget = null,
  responsePreview = null,
}: {
  chainId: number;
  poolId: string;
  status: IntegrationProbeSnapshot["aggregators"][number]["chains"][number]["pairs"][number]["status"];
  sellSymbol: string;
  error: string | null;
  sourceLabels?: string[];
  downstreamProvider?: string | null;
  txTarget?: string | null;
  responsePreview?: string | null;
}): IntegrationProbeSnapshot["aggregators"][number]["chains"][number]["pairs"][number] {
  const passing = status === "pass";
  return {
    pairId: `${chainId}:${sellSymbol}-USDm:${poolId}`,
    poolId,
    direction: "base-to-usdm",
    sellSymbol,
    buySymbol: "USDm",
    status,
    evidence: passing
      ? [
          {
            type: "router-address",
            value: "0x1111111111111111111111111111111111111111",
            path: "$.tx.to",
          },
        ]
      : [],
    sourceLabels,
    txTarget,
    downstreamProvider,
    routeVariant: passing ? "default" : null,
    routeAmountUsd: passing ? "1" : null,
    attemptCount: passing ? 3 : null,
    requestUrl: null,
    httpStatus: passing ? 200 : null,
    latencyMs: passing ? 42 : null,
    responsePreview,
    error,
  };
}
