import { describe, expect, it, vi } from "vitest";
import type { Hex, Log } from "viem";
import receipt from "./fixtures-pool-liquidity-withdrawal.json";
import {
  configuredPoolWatches,
  poolBurnCandidates,
  poolClientMsgId,
  deliverPoolLiquidityWithdrawal,
  processPoolBurns,
  provePoolLiquidityWithdrawal,
  retryPendingPoolLiquidityWithdrawals,
  stagePoolCandidate,
  type PoolLiquidityWithdrawal,
} from "./pool-liquidity-withdrawal";

vi.mock("./quicknode-replay-protection", () => ({
  STORAGE_UPLOAD_BASE_URL: "https://storage.googleapis.com/upload/storage/v1/b",
  getMetadataAccessToken: vi.fn(async () => "test-token"),
}));
vi.mock("./slack", () => ({ sendToSlack: vi.fn() }));

const watch = {
  id: "polygon-eurm-usdm-lp-1",
  poolAddress: "0x93e15a22fda39fefccce82d387a09ccf030ead61" as const,
  lpAddress: "0x3d54f9496bf5bd0afa67c80ee8bc2eeadf306381" as const,
  token0Symbol: "EURm",
  token1Symbol: "USDm",
  token0Decimals: 18,
  token1Decimals: 18,
};
const candidate = {
  txHash: receipt.transactionHash as Hex,
  logIndex: 839,
  watch,
};
const sourceReceipt = {
  ...receipt,
  transactionHash: candidate.txHash,
  logs: receipt.logs as unknown as Log[],
};
const event = provePoolLiquidityWithdrawal(candidate, sourceReceipt)!;

describe("Watched LP Polygon withdrawal", () => {
  it("validates the configured watches and preserves stable IDs", () => {
    expect(configuredPoolWatches(JSON.stringify([watch]))).toEqual([watch]);
    expect(() => configuredPoolWatches(JSON.stringify([watch, watch]))).toThrow(
      "Duplicate",
    );
    expect(() =>
      configuredPoolWatches(
        JSON.stringify([watch, { ...watch, id: "another-watch" }]),
      ),
    ).toThrow("Duplicate pool liquidity watch wallet");
  });
  it("finds the exact Burn in decoded and raw receipt envelopes", () => {
    expect(
      poolBurnCandidates(
        {
          result: [
            {
              address: watch.poolAddress,
              name: "Burn",
              transactionHash: candidate.txHash,
              logIndex: "839",
            },
          ],
        },
        [watch],
      ),
    ).toEqual([candidate]);
    expect(
      poolBurnCandidates({ matchingReceipts: [sourceReceipt] }, [watch]),
    ).toEqual([candidate]);
    expect(
      poolBurnCandidates(
        {
          result: [
            {
              address: "0x0000000000000000000000000000000000000001",
              name: "Burn",
              transactionHash: candidate.txHash,
              logIndex: 839,
            },
          ],
        },
        [watch],
      ),
    ).toEqual([]);
    expect(() =>
      poolBurnCandidates(
        {
          result: [{ address: watch.poolAddress, name: "Burn", logIndex: 839 }],
        },
        [watch],
      ),
    ).toThrow("missing transaction hash");
  });

  it("keeps same-pool wallets as distinct event keys and proves only the LP owner", () => {
    const otherWatch = {
      ...watch,
      id: "polygon-eurm-usdm-lp-2",
      lpAddress: "0x0000000000000000000000000000000000000001" as const,
    };
    const candidates = poolBurnCandidates(
      {
        result: [
          {
            address: watch.poolAddress,
            name: "Burn",
            transactionHash: candidate.txHash,
            logIndex: candidate.logIndex,
          },
        ],
      },
      [watch, otherWatch],
    );
    expect(candidates).toHaveLength(2);
    expect(
      provePoolLiquidityWithdrawal(candidates[0], sourceReceipt),
    ).not.toBeNull();
    expect(
      provePoolLiquidityWithdrawal(candidates[1], sourceReceipt),
    ).toBeNull();
    expect(poolClientMsgId(candidates[0])).not.toBe(
      poolClientMsgId(candidates[1]),
    );
  });

  it("requires successful receipt, exact burn, and Watched LP Safe LP transfers even when tx swaps", () => {
    expect(event).toMatchObject({
      ...candidate,
      amount0: 11979702533637744148688n,
      amount1: 31139749333024582544384n,
    });
    expect(
      provePoolLiquidityWithdrawal(candidate, {
        ...sourceReceipt,
        status: "reverted",
      }),
    ).toBeNull();
    expect(
      provePoolLiquidityWithdrawal(
        { ...candidate, logIndex: 844 },
        sourceReceipt,
      ),
    ).toBeNull();
    expect(
      provePoolLiquidityWithdrawal(candidate, {
        ...sourceReceipt,
        transactionHash: `0x${"00".repeat(32)}` as Hex,
      }),
    ).toBeNull();
    expect(
      provePoolLiquidityWithdrawal(candidate, {
        ...sourceReceipt,
        logs: sourceReceipt.logs.filter((log) => log.logIndex !== 834),
      }),
    ).toBeNull();
    expect(
      provePoolLiquidityWithdrawal(candidate, {
        ...sourceReceipt,
        logs: sourceReceipt.logs.filter((log) => log.logIndex !== 835),
      }),
    ).toBeNull();
    const wrongOwner = structuredClone(sourceReceipt);
    wrongOwner.logs[0].topics[1] = `0x${"00".repeat(32)}`;
    expect(
      provePoolLiquidityWithdrawal(
        candidate,
        wrongOwner as typeof sourceReceipt,
      ),
    ).toBeNull();
  });

  it("does not use decoded event args as proof, and deduplicates receipt fetches per transaction", async () => {
    const getReceipt = vi.fn(async () => sourceReceipt);
    const send = vi.fn(async () => "delivered" as const);
    const stage = vi.fn(async () => {});
    const ignore = vi.fn(async () => {});
    await processPoolBurns([candidate, candidate], {
      receipt: getReceipt,
      deliver: send,
      stage,
      ignore,
    });
    expect(stage).toHaveBeenCalledTimes(2);
    expect(getReceipt).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    await processPoolBurns([candidate], {
      receipt: async () => ({ ...sourceReceipt, status: "reverted" }),
      deliver: send,
      stage,
      ignore,
    });
    expect(ignore).toHaveBeenCalledWith(candidate);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps staging failures fatal but delivers independently staged siblings", async () => {
    const stage = vi
      .fn()
      .mockRejectedValueOnce(new Error("GCS unavailable"))
      .mockResolvedValueOnce(undefined);
    const deliver = vi.fn(async () => "delivered" as const);
    await expect(
      processPoolBurns([candidate, candidate], {
        stage,
        receipt: async () => sourceReceipt,
        deliver,
      }),
    ).rejects.toThrow("1 candidate(s) pending");
    expect(stage).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("continues other staged candidates after a delivery failure", async () => {
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new Error("Slack 503"))
      .mockResolvedValueOnce("delivered");
    await expect(
      processPoolBurns([candidate, candidate], {
        stage: async () => {},
        receipt: async () => sourceReceipt,
        deliver,
      }),
    ).rejects.toThrow("1 candidate(s) pending");
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("uses one stable client_msg_id, GCS generation CAS, and retries a pending Slack failure", async () => {
    let stored: { record: Record<string, unknown>; generation: string } | null =
      null;
    let generation = 0;
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/upload/")) {
        const expected = url.searchParams.get("ifGenerationMatch");
        if (expected !== (stored?.generation ?? "0"))
          return new Response("", { status: 412 });
        const record = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        stored = { record, generation: String(++generation) };
        return Response.json({ generation: stored.generation });
      }
      if (url.searchParams.get("alt") === "media")
        return Response.json(stored!.record);
      return Response.json({ generation: stored!.generation });
    });
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("Slack 503"))
      .mockResolvedValue(undefined);
    const options = {
      fetchImpl: fetchImpl as typeof fetch,
      bucket: "test-bucket",
      channel: "C0B53R34HTN",
      token: "xoxb-test",
      send,
      now: () => 1_000,
    };
    await stagePoolCandidate(candidate, {
      fetchImpl: fetchImpl as typeof fetch,
      bucket: "test-bucket",
    });
    expect(stored?.record.state).toBe("unverified");
    await expect(
      deliverPoolLiquidityWithdrawal(event, options),
    ).rejects.toThrow("Slack 503");
    expect(stored?.record.state).toBe("pending");
    expect(await deliverPoolLiquidityWithdrawal(event, options)).toBe("leased");
    expect(
      await deliverPoolLiquidityWithdrawal(event, {
        ...options,
        now: () => 62_000,
      }),
    ).toBe("delivered");
    expect(await deliverPoolLiquidityWithdrawal(event, options)).toBe(
      "already-delivered",
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][4]).toBe(poolClientMsgId(event));
    expect(send.mock.calls[1][4]).toBe(poolClientMsgId(event));
    expect(stored?.record.state).toBe("delivered");
  });

  it("lists persisted pending events for retry after QuickNode's signature window", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.has("prefix"))
        return Response.json({
          items: [
            {
              name: `pool-liquidity-withdrawals/137/${watch.id}/${candidate.txHash}-${candidate.logIndex}.json`,
            },
          ],
        });
      if (url.searchParams.get("alt") === "media")
        return Response.json({
          state: "pending",
          leaseUntil: 0,
          event: {
            ...candidate,
            amount0: String(event.amount0),
            amount1: String(event.amount1),
            liquidity: String(event.liquidity),
          },
          clientMsgId: poolClientMsgId(event),
        });
      return Response.json({ generation: "1" });
    });
    const deliver = vi.fn(
      async (_event: PoolLiquidityWithdrawal) => "delivered" as const,
    );
    expect(
      await retryPendingPoolLiquidityWithdrawals({
        fetchImpl: fetchImpl as typeof fetch,
        bucket: "test-bucket",
        deliver,
      }),
    ).toBe(1);
    expect(deliver).toHaveBeenCalledWith(event);
  });

  it("re-proves a staged candidate after an RPC outage", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.has("prefix"))
        return Response.json({
          items: [
            {
              name: `pool-liquidity-withdrawals/137/${watch.id}/${candidate.txHash}-${candidate.logIndex}.json`,
            },
          ],
        });
      if (url.searchParams.get("alt") === "media")
        return Response.json({
          state: "unverified",
          leaseUntil: 0,
          event: { ...candidate, amount0: "0", amount1: "0", liquidity: "0" },
          clientMsgId: poolClientMsgId(event),
        });
      return Response.json({ generation: "1" });
    });
    const verify = vi.fn(async () => {});
    expect(
      await retryPendingPoolLiquidityWithdrawals({
        fetchImpl: fetchImpl as typeof fetch,
        bucket: "test-bucket",
        verify,
      }),
    ).toBe(1);
    expect(verify).toHaveBeenCalledWith([candidate]);
  });

  it("stops at 25 pending retries without treating deferred records as failures", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.has("prefix"))
        return Response.json({
          items: Array.from({ length: 27 }, (_, logIndex) => ({
            name: `pool-liquidity-withdrawals/137/${watch.id}/${candidate.txHash}-${logIndex}.json`,
          })),
        });
      if (url.searchParams.get("alt") === "media") {
        const match = /-(\d+)\.json$/.exec(decodeURIComponent(url.pathname));
        return Response.json({
          state: "pending",
          leaseUntil: 0,
          event: {
            ...candidate,
            logIndex: Number(match?.[1]),
            amount0: "1",
            amount1: "1",
            liquidity: "1",
          },
          clientMsgId: poolClientMsgId(candidate),
        });
      }
      return Response.json({ generation: "1" });
    });
    const deliver = vi.fn(async () => "delivered" as const);
    await expect(
      retryPendingPoolLiquidityWithdrawals({
        fetchImpl: fetchImpl as typeof fetch,
        bucket: "test-bucket",
        deliver,
      }),
    ).rejects.toThrow("exceeded 25 pending events");
    expect(deliver).toHaveBeenCalledTimes(25);
  });
});
