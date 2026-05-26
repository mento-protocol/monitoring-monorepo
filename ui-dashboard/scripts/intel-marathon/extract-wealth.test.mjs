import { describe, expect, it } from "vitest";
import { buildWealthWriteCommand } from "./extract-wealth.mjs";

const address = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD";
const sources = ["test-source"];

function portfolioSnapshots(overrides = {}) {
  return [0, 30, 90, 180].map((days, index) => {
    const label = `${days}d_ago`;
    return {
      label,
      ts: 1_700_000_000_000 - index * 86_400_000,
      response: overrides[label] ?? {
        status: 200,
        data: { totalBalance: index + 1 },
      },
    };
  });
}

describe("buildWealthWriteCommand", () => {
  it("does not enqueue an HSET when balances return 404", () => {
    const result = buildWealthWriteCommand({
      address,
      sources,
      balances: { status: 404, data: null },
      portfolioSnapshots: portfolioSnapshots(),
    });

    expect(result).toEqual({
      ok: false,
      status: "notFound",
      reason: "balances_not_found",
    });
    expect(result.command).toBeUndefined();
  });

  it("does not enqueue an HSET when balances are incomplete", () => {
    const result = buildWealthWriteCommand({
      address,
      sources,
      balances: { status: 500, data: null },
      portfolioSnapshots: portfolioSnapshots(),
    });

    expect(result).toEqual({
      ok: false,
      status: "incomplete",
      reason: "balances_incomplete",
    });
  });

  it("does not enqueue an HSET when any required portfolio snapshot returns 404", () => {
    const result = buildWealthWriteCommand({
      address,
      sources,
      balances: { status: 200, data: { balances: [] } },
      portfolioSnapshots: portfolioSnapshots({
        "90d_ago": { status: 404, data: null },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("notFound");
    expect(result.reason).toBe("portfolio_90d_ago_not_found");
    expect(result.command).toBeUndefined();
  });

  it("does not enqueue an HSET when any required portfolio snapshot is incomplete", () => {
    const result = buildWealthWriteCommand({
      address,
      sources,
      balances: { status: 200, data: { balances: [] } },
      portfolioSnapshots: portfolioSnapshots({
        "30d_ago": { status: 503, data: null },
      }),
    });

    expect(result).toEqual({
      ok: false,
      status: "incomplete",
      reason: "portfolio_30d_ago_incomplete",
    });
  });

  it("does not enqueue an HSET when a required portfolio snapshot is missing", () => {
    const result = buildWealthWriteCommand({
      address,
      sources,
      balances: { status: 200, data: { balances: [] } },
      portfolioSnapshots: portfolioSnapshots().slice(0, 3),
    });

    expect(result).toEqual({
      ok: false,
      status: "incomplete",
      reason: "portfolio_180d_ago_missing",
    });
  });

  it("builds an intel_wealth HSET only when balances and all portfolio snapshots are complete", () => {
    const result = buildWealthWriteCommand({
      address,
      sources,
      balances: { status: 200, data: { balances: [{ symbol: "CELO" }] } },
      portfolioSnapshots: portfolioSnapshots(),
      fetchedAt: "2026-05-26T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    expect(result.command.slice(0, 3)).toEqual([
      "HSET",
      "intel_wealth",
      address.toLowerCase(),
    ]);
    const record = JSON.parse(result.command[3]);
    expect(record).toMatchObject({
      address,
      fetchedAt: "2026-05-26T00:00:00.000Z",
      sources,
      balances: { balances: [{ symbol: "CELO" }] },
      version: 1,
    });
    expect(Object.keys(record.portfolio)).toEqual([
      "0d_ago",
      "30d_ago",
      "90d_ago",
      "180d_ago",
    ]);
  });

  it("returns the same truncated record that it stores in Redis", () => {
    const result = buildWealthWriteCommand({
      address,
      sources,
      balances: { status: 200, data: { large: "x".repeat(50_000) } },
      portfolioSnapshots: portfolioSnapshots(),
      fetchedAt: "2026-05-26T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    expect(result.record._truncated).toBe(true);
    expect(JSON.parse(result.command[3])).toEqual(result.record);
  });
});
