import { describe, expect, it } from "vitest";
import { contractEntries } from "@mento-protocol/config/tokens";
import { runIntegrationProbes } from "../runner.js";
import type { AggregatorAdapter } from "../adapters.js";
import type { PoolRow } from "../pairs.js";

const ROUTER_V300 = "0x4861840c2efb2b98312b0ae34d86fd73e8f9b6f6";
const POOL = "42220-0x3333333333333333333333333333333333333333";

describe("runIntegrationProbes", () => {
  it("can run from contract metadata when Hasura is not configured", async () => {
    const snapshot = await runIntegrationProbes({
      chainIds: [143],
      adapters: [passingAdapter()],
      env: {},
      now: new Date("2026-06-01T00:00:00.000Z"),
      fetcher: async () =>
        new Response(
          JSON.stringify({ transactionRequest: { to: ROUTER_V300 } }),
        ),
    });

    expect(snapshot.pairSource.kind).toBe("contracts-fallback");
    expect(snapshot.generatedAt).toBe("2026-06-01T00:00:00.000Z");
    expect(snapshot.summary.passingChainChecks).toBe(1);
    expect(snapshot.aggregators[0]?.chains[0]?.status).toBe("pass");
    expect(
      snapshot.aggregators[0]?.chains[0]?.pairCoverage.total,
    ).toBeGreaterThan(0);
  });

  it("derives active USDm hub pairs from Hasura rows", async () => {
    const row: PoolRow = {
      id: POOL,
      chainId: 42220,
      token0: tokenAddress("EURm"),
      token1: tokenAddress("USDm"),
      token0Decimals: 18,
      token1Decimals: 18,
      source: "fpmm_factory",
      reserves0: "1",
      reserves1: "1",
    };
    const snapshot = await runIntegrationProbes({
      chainIds: [42220],
      adapters: [passingAdapter()],
      hasuraUrl: "https://hasura.test",
      env: {},
      fetcher: async (input) => {
        if (String(input) === "https://hasura.test") {
          return new Response(JSON.stringify({ data: { Pool: [row] } }));
        }
        return new Response(
          JSON.stringify({
            route: [{ pool: "0x3333333333333333333333333333333333333333" }],
          }),
        );
      },
    });

    const chain = snapshot.aggregators[0]?.chains[0];
    expect(snapshot.pairSource.kind).toBe("hasura");
    expect(snapshot.chains[0]?.pairs).toHaveLength(1);
    expect(chain?.status).toBe("pass");
    expect(chain?.pairCoverage).toEqual({ passed: 2, total: 2 });
  });

  it("runs Polygon probes against the two active USDm hub pools", async () => {
    const rows: PoolRow[] = [
      polygonPoolRow(
        "137-0x463c0d1f04bcd99a1efcf94ac2a75bc19ea4a7e5",
        "USDC",
        "USDm",
        6,
        18,
      ),
      polygonPoolRow(
        "137-0x93e15a22fda39fefccce82d387a09ccf030ead61",
        "EURm",
        "USDm",
        18,
        18,
      ),
      polygonPoolRow(
        "137-0xcd8c6811d975981f57e7fb32e59f0bee66af3201",
        "EURm",
        "EUROP",
        18,
        6,
      ),
    ];
    const snapshot = await runIntegrationProbes({
      chainIds: [137],
      adapters: [passingAdapter()],
      hasuraUrl: "https://hasura.test",
      env: {},
      fetcher: async (request) => {
        if (String(request) === "https://hasura.test") {
          return new Response(JSON.stringify({ data: { Pool: rows } }));
        }
        return new Response(
          JSON.stringify({ transactionRequest: { to: ROUTER_V300 } }),
        );
      },
    });

    expect(snapshot.chains[0]).toMatchObject({
      chainId: 137,
      chainSlug: "polygon",
      chainLabel: "Polygon",
    });
    expect(snapshot.chains[0]?.pairs.map((pair) => pair.base.symbol)).toEqual([
      "EURm",
      "USDC",
    ]);
    expect(snapshot.aggregators[0]?.chains[0]).toMatchObject({
      status: "pass",
      pairCoverage: { passed: 4, total: 4 },
    });
  });

  it("can filter adapters and limit pairs for live debugging", async () => {
    const rows: PoolRow[] = [
      {
        id: POOL,
        chainId: 42220,
        token0: tokenAddress("EURm"),
        token1: tokenAddress("USDm"),
        token0Decimals: 18,
        token1Decimals: 18,
        source: "fpmm_factory",
        reserves0: "1",
        reserves1: "1",
      },
      {
        id: "42220-0x4444444444444444444444444444444444444444",
        chainId: 42220,
        token0: tokenAddress("GBPm"),
        token1: tokenAddress("USDm"),
        token0Decimals: 18,
        token1Decimals: 18,
        source: "fpmm_factory",
        reserves0: "1",
        reserves1: "1",
      },
    ];
    const snapshot = await runIntegrationProbes({
      chainIds: [42220],
      adapters: [passingAdapter(), skippedAdapter()],
      adapterIds: ["fixture"],
      pairLimit: 1,
      hasuraUrl: "https://hasura.test",
      env: {},
      fetcher: async (input) => {
        if (String(input) === "https://hasura.test") {
          return new Response(JSON.stringify({ data: { Pool: rows } }));
        }
        return new Response(
          JSON.stringify({
            route: [{ pool: "0x3333333333333333333333333333333333333333" }],
          }),
        );
      },
    });

    expect(snapshot.aggregators).toHaveLength(1);
    expect(snapshot.aggregators[0]?.id).toBe("fixture");
    expect(snapshot.chains[0]?.pairs).toHaveLength(1);
    expect(snapshot.aggregators[0]?.chains[0]?.pairCoverage.total).toBe(2);
  });

  it("keeps pool ids normalized when an adapter throws", async () => {
    const row: PoolRow = {
      id: POOL,
      chainId: 42220,
      token0: tokenAddress("EURm"),
      token1: tokenAddress("USDm"),
      token0Decimals: 18,
      token1Decimals: 18,
      source: "fpmm_factory",
      reserves0: "1",
      reserves1: "1",
    };
    const snapshot = await runIntegrationProbes({
      chainIds: [42220],
      adapters: [throwingAdapter()],
      hasuraUrl: "https://hasura.test",
      env: {},
      fetcher: async (input) => {
        if (String(input) === "https://hasura.test") {
          return new Response(JSON.stringify({ data: { Pool: [row] } }));
        }
        return new Response("{}");
      },
    });

    expect(snapshot.aggregators[0]?.chains[0]?.pairs[0]?.status).toBe("error");
    expect(snapshot.aggregators[0]?.chains[0]?.pairs[0]?.poolId).toBe(POOL);
  });

  it("marks a chain partial when only some pair directions pass", async () => {
    const snapshot = await runIntegrationProbes({
      chainIds: [42220],
      adapters: [mixedCoverageAdapter()],
      hasuraUrl: "https://hasura.test",
      env: {},
      fetcher: async (input) => {
        if (String(input) === "https://hasura.test") {
          return new Response(
            JSON.stringify({ data: { Pool: [poolRow(POOL, "EURm")] } }),
          );
        }
        return new Response(
          String(input).includes("base-to-usdm")
            ? JSON.stringify({ transactionRequest: { to: ROUTER_V300 } })
            : JSON.stringify({ route: [{ protocol: "Other" }] }),
        );
      },
    });

    const chain = snapshot.aggregators[0]?.chains[0];
    expect(chain?.status).toBe("partial");
    expect(chain?.pairCoverage).toEqual({ passed: 1, total: 2 });
    expect(chain?.blockingReason).toBe(
      "Some USDm hub routes passed, but full pair coverage is not healthy.",
    );
    expect(snapshot.summary.partialChainChecks).toBe(1);
    expect(snapshot.summary.failingChainChecks).toBe(0);
  });

  it("bounds pair probe concurrency", async () => {
    const rowA = poolRow(POOL, "EURm");
    const rowB = poolRow(
      "42220-0x4444444444444444444444444444444444444444",
      "GBPm",
    );
    let active = 0;
    let maxActive = 0;
    const snapshot = await runIntegrationProbes({
      chainIds: [42220],
      adapters: [passingAdapter()],
      pairConcurrency: 2,
      hasuraUrl: "https://hasura.test",
      env: {},
      fetcher: async (input) => {
        if (String(input) === "https://hasura.test") {
          return new Response(JSON.stringify({ data: { Pool: [rowA, rowB] } }));
        }
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return new Response(
          JSON.stringify({
            route: [{ pool: "0x3333333333333333333333333333333333333333" }],
          }),
        );
      },
    });

    expect(snapshot.aggregators[0]?.chains[0]?.pairCoverage.total).toBe(4);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("shares adapter quote-attempt budgets across pair probes", async () => {
    let quoteFetches = 0;
    const snapshot = await runIntegrationProbes({
      chainIds: [42220],
      adapters: [budgetedAdapter()],
      pairConcurrency: 1,
      hasuraUrl: "https://hasura.test",
      env: {},
      fetcher: async (input) => {
        if (String(input) === "https://hasura.test") {
          return new Response(
            JSON.stringify({ data: { Pool: [poolRow(POOL, "EURm")] } }),
          );
        }
        quoteFetches += 1;
        return new Response(JSON.stringify({ route: [{ protocol: "Other" }] }));
      },
    });

    const pairs = snapshot.aggregators[0]?.chains[0]?.pairs ?? [];
    expect(quoteFetches).toBe(3);
    expect(pairs.map((pair) => pair.attemptCount)).toEqual([2, 1]);
    expect(pairs.map((pair) => pair.status)).toContain("budget_exhausted");
    expect(snapshot.summary.failingChainChecks).toBe(1);
  });

  it("uses the budget next step for partial chains with exhausted budget", async () => {
    let quoteFetches = 0;
    const snapshot = await runIntegrationProbes({
      chainIds: [42220],
      adapters: [
        {
          ...passingAdapter(),
          id: "partial-budgeted",
          label: "Partial Budgeted",
          maxQuoteRequestsPerRun: 1,
          quote: (input) => ({
            url: `https://partial-budgeted.test/${input.direction}`,
          }),
        },
      ],
      pairConcurrency: 1,
      hasuraUrl: "https://hasura.test",
      env: {},
      fetcher: async (input) => {
        if (String(input) === "https://hasura.test") {
          return new Response(
            JSON.stringify({ data: { Pool: [poolRow(POOL, "EURm")] } }),
          );
        }
        quoteFetches += 1;
        return new Response(
          JSON.stringify({ transactionRequest: { to: ROUTER_V300 } }),
        );
      },
    });

    const chain = snapshot.aggregators[0]?.chains[0];
    expect(quoteFetches).toBe(1);
    expect(chain?.status).toBe("partial");
    expect(chain?.pairs.map((pair) => pair.status)).toEqual([
      "pass",
      "budget_exhausted",
    ]);
    expect(chain?.nextStep).toContain("maxQuoteRequestsPerRun");
  });

  it("keeps the generic partial next step when budget exhaustion follows failed routes", async () => {
    let quoteFetches = 0;
    const rows = [
      poolRow(POOL, "EURm"),
      poolRow("42220-0x4444444444444444444444444444444444444444", "GBPm"),
    ];
    const snapshot = await runIntegrationProbes({
      chainIds: [42220],
      adapters: [
        {
          ...passingAdapter(),
          id: "partial-failed-budgeted",
          label: "Partial Failed Budgeted",
          maxQuoteRequestsPerRun: 2,
          quote: (input) => ({
            url: `https://partial-failed-budgeted.test/${input.pairId}/${input.direction}`,
          }),
        },
      ],
      pairConcurrency: 1,
      hasuraUrl: "https://hasura.test",
      env: {},
      fetcher: async (input) => {
        if (String(input) === "https://hasura.test") {
          return new Response(JSON.stringify({ data: { Pool: rows } }));
        }
        quoteFetches += 1;
        return new Response(
          quoteFetches === 1
            ? JSON.stringify({ transactionRequest: { to: ROUTER_V300 } })
            : JSON.stringify({ route: [{ protocol: "Other" }] }),
        );
      },
    });

    const chain = snapshot.aggregators[0]?.chains[0];
    expect(quoteFetches).toBe(2);
    expect(chain?.status).toBe("partial");
    expect(chain?.pairs.map((pair) => pair.status)).toEqual([
      "pass",
      "fail",
      "budget_exhausted",
      "budget_exhausted",
    ]);
    expect(chain?.nextStep).toContain("route evidence");
    expect(chain?.nextStep).not.toContain("maxQuoteRequestsPerRun");
  });

  it("logs a per-adapter quote-budget summary line", async () => {
    const lines: string[] = [];
    await runIntegrationProbes({
      chainIds: [42220],
      adapters: [budgetedAdapter()],
      pairConcurrency: 1,
      hasuraUrl: "https://hasura.test",
      env: {},
      log: (line) => lines.push(line),
      fetcher: async (input) => {
        if (String(input) === "https://hasura.test") {
          return new Response(
            JSON.stringify({ data: { Pool: [poolRow(POOL, "EURm")] } }),
          );
        }
        return new Response(JSON.stringify({ route: [{ protocol: "Other" }] }));
      },
    });

    expect(lines).toContain(
      "[integration-probes] adapter=budgeted quoteAttempts=3/3 remainingBudget=0",
    );
  });

  it("serializes budgeted adapter pair probes", async () => {
    const rowA = poolRow(POOL, "EURm");
    const rowB = poolRow(
      "42220-0x4444444444444444444444444444444444444444",
      "GBPm",
    );
    let active = 0;
    let maxActive = 0;
    await runIntegrationProbes({
      chainIds: [42220],
      adapters: [budgetedPassingAdapter()],
      pairConcurrency: 4,
      hasuraUrl: "https://hasura.test",
      env: {},
      fetcher: async (input) => {
        if (String(input) === "https://hasura.test") {
          return new Response(JSON.stringify({ data: { Pool: [rowA, rowB] } }));
        }
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return new Response(
          JSON.stringify({
            route: [{ pool: "0x3333333333333333333333333333333333333333" }],
          }),
        );
      },
    });

    expect(maxActive).toBe(1);
  });

  it("serializes paced adapter pair probes", async () => {
    const rowA = poolRow(POOL, "EURm");
    const rowB = poolRow(
      "42220-0x4444444444444444444444444444444444444444",
      "GBPm",
    );
    let active = 0;
    let maxActive = 0;
    await runIntegrationProbes({
      chainIds: [42220],
      adapters: [pacedPassingAdapter()],
      pairConcurrency: 4,
      hasuraUrl: "https://hasura.test",
      env: {},
      fetcher: async (input) => {
        if (String(input) === "https://hasura.test") {
          return new Response(JSON.stringify({ data: { Pool: [rowA, rowB] } }));
        }
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return new Response(
          JSON.stringify({
            route: [{ pool: "0x3333333333333333333333333333333333333333" }],
          }),
        );
      },
    });

    expect(maxActive).toBe(1);
  });

  it("runs independent adapters concurrently", async () => {
    const starts: string[] = [];
    await runIntegrationProbes({
      chainIds: [42220],
      adapters: [namedAdapter("first"), namedAdapter("second")],
      adapterConcurrency: 2,
      pairConcurrency: 1,
      pairLimit: 1,
      hasuraUrl: "https://hasura.test",
      env: {},
      fetcher: async (input) => {
        if (String(input) === "https://hasura.test") {
          return new Response(
            JSON.stringify({ data: { Pool: [poolRow(POOL, "EURm")] } }),
          );
        }
        starts.push(String(input));
        await new Promise((resolve) => setTimeout(resolve, 1));
        return new Response(
          JSON.stringify({
            route: [{ pool: "0x3333333333333333333333333333333333333333" }],
          }),
        );
      },
    });

    expect(starts.slice(0, 2).sort()).toEqual([
      "https://first.test",
      "https://second.test",
    ]);
  });

  it("rejects unknown selected adapter ids", async () => {
    await expect(
      runIntegrationProbes({
        chainIds: [42220],
        adapters: [passingAdapter()],
        adapterIds: ["missing"],
        env: {},
        fetcher: async () => new Response("{}"),
      }),
    ).rejects.toThrow("Unknown adapter id");
  });
});

function namedAdapter(id: string): AggregatorAdapter {
  return {
    id,
    label: id,
    kind: "dex",
    tier: 1,
    support: { 42220: "supported" },
    researchNote: id,
    quote: () => ({ url: `https://${id}.test` }),
  };
}

function poolRow(id: string, baseSymbol: string): PoolRow {
  return {
    id,
    chainId: 42220,
    token0: tokenAddress(baseSymbol),
    token1: tokenAddress("USDm"),
    token0Decimals: 18,
    token1Decimals: 18,
    source: "fpmm_factory",
    reserves0: "1",
    reserves1: "1",
  };
}

function passingAdapter(): AggregatorAdapter {
  return {
    id: "fixture",
    label: "Fixture",
    kind: "dex",
    tier: 1,
    support: { 42220: "supported", 143: "supported", 137: "supported" },
    researchNote: "fixture",
    quote: () => ({ url: "https://quote.test" }),
  };
}

function mixedCoverageAdapter(): AggregatorAdapter {
  return {
    ...passingAdapter(),
    id: "mixed",
    label: "Mixed",
    quote: (input) => ({ url: `https://mixed.test/${input.direction}` }),
  };
}

function budgetedAdapter(): AggregatorAdapter {
  return {
    id: "budgeted",
    label: "Budgeted",
    kind: "dex",
    tier: 1,
    support: { 42220: "supported" },
    maxQuoteRequestsPerRun: 3,
    researchNote: "budgeted",
    quote: () => [
      { url: "https://budgeted.test/default", variant: "default" },
      { url: "https://budgeted.test/discovery", variant: "discovery" },
    ],
  };
}

function budgetedPassingAdapter(): AggregatorAdapter {
  return {
    ...passingAdapter(),
    maxQuoteRequestsPerRun: 100,
  };
}

function pacedPassingAdapter(): AggregatorAdapter {
  return {
    ...passingAdapter(),
    quoteRequestDelayMs: 1,
  };
}

function throwingAdapter(): AggregatorAdapter {
  return {
    id: "throwing",
    label: "Throwing",
    kind: "dex",
    tier: 1,
    support: { 42220: "supported" },
    researchNote: "throwing",
    quote: () => {
      throw new Error("quote failed");
    },
  };
}

function skippedAdapter(): AggregatorAdapter {
  return {
    id: "skipped",
    label: "Skipped",
    kind: "dex",
    tier: 1,
    support: { 42220: "supported", 143: "supported", 137: "supported" },
    researchNote: "skipped",
    quote: () => ({ url: "https://skipped.test" }),
  };
}

function tokenAddress(symbol: string): string {
  return tokenAddressFor(42220, symbol);
}

function tokenAddressFor(chainId: number, symbol: string): string {
  const entry = contractEntries(chainId).find(
    (candidate) =>
      candidate.type === "token" && candidate.canonicalName === symbol,
  );
  if (!entry) throw new Error(`Missing ${symbol} test token on ${chainId}`);
  return entry.address;
}

function polygonPoolRow(
  id: string,
  token0Symbol: string,
  token1Symbol: string,
  token0Decimals: number,
  token1Decimals: number,
): PoolRow {
  return {
    id,
    chainId: 137,
    token0: tokenAddressFor(137, token0Symbol),
    token1: tokenAddressFor(137, token1Symbol),
    token0Decimals,
    token1Decimals,
    source: "fpmm_factory",
    reserves0: "1",
    reserves1: "1",
  };
}
