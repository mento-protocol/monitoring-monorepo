import { describe, expect, it, vi } from "vitest";
import { createDiscovery } from "./tier1-discovery.mjs";
const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
describe("tier1 discovery", () => {
  it("pages at the server cap and preserves source query shape", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: { rows: Array(1000).fill({ address: address(1) }) },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ data: { rows: [{ address: address(2) }] } }),
      );
    const result = await createDiscovery({ fetch }).pageSource({
      table: "LiquidityPosition",
      addressFields: ["address"],
    });
    expect(result.rows).toHaveLength(1001);
    expect(result.capped).toBe(false);
    expect(JSON.parse(fetch.mock.calls[1][1].body).variables).toEqual({
      limit: 1000,
      offset: 1000,
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body).query).toContain(
      "order_by: { id: asc }",
    );
  });
  it("treats a hard page cap as incomplete discovery", async () => {
    const fetch = vi.fn(async (_url, init) =>
      Response.json({
        data: {
          rows: JSON.parse(init.body).query.includes("rows: Trove(")
            ? Array(1000).fill({ owner: address(1) })
            : [],
        },
      }),
    );
    const exit = vi.fn(() => {
      throw new Error("exit");
    });
    await expect(
      createDiscovery({ fetch, console: quiet, exit }).discoverAll(),
    ).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(fetch).toHaveBeenCalledTimes(260);
  });
  it("deduplicates across fields and chains while retaining volume and non-Broker priority", async () => {
    const fetch = vi.fn(async (_url, init) => {
      const query = JSON.parse(init.body).query;
      let rows = [];
      if (query.includes("rows: TraderAllTimeAggregate("))
        rows = [
          {
            trader: address(1).toUpperCase().replace("0X", "0x"),
            volumeUsdWei: "3",
          },
          { trader: address(1), volumeUsdWei: "4" },
        ];
      if (query.includes("rows: BrokerTraderAllTimeAggregate("))
        rows = [{ caller: address(1), volumeUsdWei: "5" }];
      if (query.includes("rows: Trove("))
        rows = [
          { owner: address(2), previousOwner: address(2) },
          { owner: address(0), previousOwner: "bad" },
        ];
      return Response.json({ data: { rows } });
    });
    const { registry, perSource } = await createDiscovery({
      fetch,
      console: quiet,
    }).discoverAll();
    expect(registry.size).toBe(2);
    expect(registry.get(address(1))).toMatchObject({
      volumeWei: 12n,
      nonBroker: true,
    });
    expect(perSource["TraderAllTimeAggregate.trader"]).toBe(1);
    expect(registry.get(address(2)).sources).toEqual([
      "Trove.owner",
      "Trove.previousOwner",
    ]);
  });
  it("orders refresh, non-Broker, then Broker by volume with stable address ties", () => {
    const registry = new Map([
      [address(4), { sources: [], volumeWei: 100n, nonBroker: false }],
      [address(3), { sources: [], volumeWei: 2n, nonBroker: true }],
      [address(2), { sources: [], volumeWei: 2n, nonBroker: true }],
      [address(5), { sources: [], volumeWei: 50n, nonBroker: false }],
    ]);
    const existing = {
      [address(1)]: { source: "arkham" },
      [address(5)]: { name: "Manual" },
    };
    const plan = createDiscovery().buildQueue(registry, existing);
    expect(plan.queue.map((c) => c.address)).toEqual([1, 2, 3, 4].map(address));
    expect(plan.manualSkipped).toBe(1);
    expect(
      createDiscovery({ refresh: false })
        .buildQueue(registry, existing)
        .queue.map((c) => c.address),
    ).toEqual([2, 3, 4].map(address));
  });
});
