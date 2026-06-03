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
    expect(html).toContain("Pass");
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
    expect(html).toContain("missing router evidence");
    expect(html).toContain("1 more route checks in the snapshot.");
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
        credentialEnv: [],
        researchNote: "fixture",
        chains: [
          chainFixture(42220, "Celo", "pass"),
          chainFixture(143, "Monad", "needs_key"),
        ],
      },
      {
        id: "cow-swap",
        label: "CoW Swap",
        kind: "excluded",
        tier: 3,
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
      passingChainChecks: 1,
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

function pairFixture({
  chainId,
  poolId,
  status,
  sellSymbol,
  error,
}: {
  chainId: number;
  poolId: string;
  status: IntegrationProbeSnapshot["aggregators"][number]["chains"][number]["pairs"][number]["status"];
  sellSymbol: string;
  error: string | null;
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
    sourceLabels: [],
    txTarget: null,
    downstreamProvider: null,
    routeVariant: passing ? "default" : null,
    routeAmountUsd: passing ? "1" : null,
    attemptCount: passing ? 3 : null,
    requestUrl: null,
    httpStatus: passing ? 200 : null,
    latencyMs: passing ? 42 : null,
    responsePreview: null,
    error,
  };
}
