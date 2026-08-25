import { describe, expect, it, vi } from "vitest";
import {
  buildWealthWriteCommand,
  fetchHashViaHscan,
} from "./extract-wealth.mjs";

function hscanResponse(cursor, flat) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ result: [cursor, flat] }),
  };
}

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

describe("fetchHashViaHscan", () => {
  it("never issues a whole-hash HGETALL — pages through HSCAN and merges every page", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        hscanResponse("7", ["0xaaa", '{"v":1}', "0xbbb", '{"v":2}']),
      )
      .mockResolvedValueOnce(hscanResponse("0", ["0xccc", '{"v":3}']));

    const flat = await fetchHashViaHscan("intel_deep", { fetchImpl });

    expect(flat).toEqual([
      "0xaaa",
      '{"v":1}',
      "0xbbb",
      '{"v":2}',
      "0xccc",
      '{"v":3}',
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toContain("/hscan/intel_deep/0");
    expect(fetchImpl.mock.calls[1][0]).toContain("/hscan/intel_deep/7");
    // Refusing a whole-hash call proves the fix never falls back to it:
    // intel_deep already exceeds Upstash REST's 10MB single-response cap.
    expect(
      fetchImpl.mock.calls.some(([url]) => url.includes("/hgetall/")),
    ).toBe(false);
  });

  it("keeps the later page's value when HSCAN returns the same field twice", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(hscanResponse("3", ["0xaaa", '"stale"']))
      .mockResolvedValueOnce(hscanResponse("0", ["0xaaa", '"fresh"']));

    const flat = await fetchHashViaHscan("intel_deep", { fetchImpl });

    expect(flat).toEqual(["0xaaa", '"fresh"']);
  });

  it("throws when Upstash answers with HTTP 200 and an error body field", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          error: "ERR max request size exceeded. Limit: 10485760 bytes",
        }),
    });

    await expect(
      fetchHashViaHscan("intel_deep", { fetchImpl }),
    ).rejects.toThrow(/max request size exceeded/);
  });

  it("aborts instead of looping forever when the cursor never returns to 0", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(hscanResponse("never-zero", ["0xaaa", '{"v":1}']));

    await expect(
      fetchHashViaHscan("intel_deep", { fetchImpl }),
    ).rejects.toThrow(/did not terminate/);
  });
});
