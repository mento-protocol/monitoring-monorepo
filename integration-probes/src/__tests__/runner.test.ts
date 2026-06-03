import { describe, expect, it } from "vitest";
import { contractEntries } from "@mento-protocol/monitoring-config/tokens";
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
    support: { 42220: "supported", 143: "supported" },
    researchNote: "fixture",
    quote: () => ({ url: "https://quote.test" }),
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
    support: { 42220: "supported", 143: "supported" },
    researchNote: "skipped",
    quote: () => ({ url: "https://skipped.test" }),
  };
}

function tokenAddress(symbol: string): string {
  const entry = contractEntries(42220).find(
    (candidate) =>
      candidate.type === "token" && candidate.canonicalName === symbol,
  );
  if (!entry) throw new Error(`Missing ${symbol} test token`);
  return entry.address;
}
