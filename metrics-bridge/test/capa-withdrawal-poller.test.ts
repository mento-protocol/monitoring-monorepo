import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Log } from "viem";
import receipt from "./fixtures-capa-withdrawal.json";
import { CAPA_POOL_ID, type IndexedBurn } from "../src/capa-withdrawal.js";
import { counters, register, gauges } from "../src/metrics.js";

vi.mock("../src/graphql.js", () => ({ fetchRecentPoolBurns: vi.fn() }));
vi.mock("../src/rpc.js", () => ({ getRpcClient: vi.fn() }));

import { fetchRecentPoolBurns } from "../src/graphql.js";
import { getRpcClient } from "../src/rpc.js";
import {
  refreshCapaWithdrawals,
  pollCapaWithdrawalsOnce,
  WITHDRAWAL_WINDOW_SECONDS,
} from "../src/capa-withdrawal-poller.js";

const owner = "0x3d54f9496bf5bd0afa67c80ee8bc2eeadf306381";
const now = 1785527997 + 60;
const burn: IndexedBurn = {
  id: "137_91215318_839",
  poolId: CAPA_POOL_ID,
  kind: "BURN",
  amount0: "11979702533637744148688",
  amount1: "31139749333024582544384",
  liquidity: "20955880489363332740671",
  txHash: receipt.transactionHash,
  blockNumber: "91215318",
  blockTimestamp: "1785527997",
};
const getReceipt = vi.fn().mockResolvedValue({
  ...receipt,
  blockNumber: 91215318n,
  logs: receipt.logs as unknown as Log[],
});

async function published(): Promise<unknown[]> {
  return (await gauges.capaWithdrawal.get()).values;
}

async function pollErrors(): Promise<unknown[]> {
  return (await counters.pollErrors.get()).values;
}

describe("Capa withdrawal poll", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    register.resetMetrics();
    vi.clearAllMocks();
    vi.mocked(fetchRecentPoolBurns).mockResolvedValue([]);
    vi.mocked(getRpcClient).mockReturnValue({
      getTransactionReceipt: getReceipt,
    } as never);
    getReceipt.mockResolvedValue({
      ...receipt,
      blockNumber: 91215318n,
      logs: receipt.logs as unknown as Log[],
    });
  });

  it("publishes exact tx, actor, gross amounts and uses the bounded lookback", async () => {
    vi.mocked(fetchRecentPoolBurns).mockResolvedValue([burn]);
    await refreshCapaWithdrawals(owner, now);
    expect(fetchRecentPoolBurns).toHaveBeenCalledWith(
      now - WITHDRAWAL_WINDOW_SECONDS,
    );
    expect(await published()).toEqual([
      expect.objectContaining({
        labels: {
          event_id: burn.id,
          tx_hash: burn.txHash,
          owner,
          eurm: "11979.70",
          usdm: "31139.74",
        },
        value: 1785527997,
      }),
    ]);
  });

  it("does not publish a different owner or an old burn", async () => {
    vi.mocked(fetchRecentPoolBurns).mockResolvedValue([burn]);
    await refreshCapaWithdrawals(
      "0x13a9803d547332c81ebc6060f739821264dbcf1e",
      now,
    );
    expect(await published()).toEqual([]);
    await refreshCapaWithdrawals(owner, now + WITHDRAWAL_WINDOW_SECONDS);
    expect(await published()).toEqual([]);
  });

  it("retains the last complete sample when receipt proof fails, then clears on success", async () => {
    vi.mocked(fetchRecentPoolBurns).mockResolvedValue([burn]);
    await refreshCapaWithdrawals(owner, now);
    getReceipt.mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(refreshCapaWithdrawals(owner, now)).rejects.toThrow(
      "capa_withdrawal_rpc",
    );
    expect(await published()).toHaveLength(1);
    vi.mocked(fetchRecentPoolBurns).mockResolvedValue([]);
    await refreshCapaWithdrawals(owner, now);
    expect(await published()).toEqual([]);
  });

  it("records Hasura and Polygon RPC failures as separate poll-error kinds", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(fetchRecentPoolBurns).mockRejectedValueOnce(
      new Error("Hasura unavailable"),
    );
    await pollCapaWithdrawalsOnce();

    vi.mocked(fetchRecentPoolBurns).mockResolvedValue([burn]);
    getReceipt.mockRejectedValueOnce(new Error("Polygon RPC unavailable"));
    await pollCapaWithdrawalsOnce();

    expect(await pollErrors()).toEqual([
      expect.objectContaining({
        labels: { kind: "capa_withdrawal_query" },
        value: 1,
      }),
      expect.objectContaining({
        labels: { kind: "capa_withdrawal_rpc" },
        value: 1,
      }),
    ]);
  });

  it("classifies a missing Polygon RPC client without querying Hasura", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(getRpcClient).mockReturnValueOnce(null);
    await pollCapaWithdrawalsOnce();
    expect(fetchRecentPoolBurns).not.toHaveBeenCalled();
    expect(await pollErrors()).toEqual([
      expect.objectContaining({
        labels: { kind: "capa_withdrawal_rpc" },
        value: 1,
      }),
    ]);
  });
});
