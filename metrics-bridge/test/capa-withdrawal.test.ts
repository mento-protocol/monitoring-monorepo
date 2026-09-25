import { describe, expect, it } from "vitest";
import type { Log } from "viem";
import receipt from "./fixtures-capa-withdrawal.json";
import {
  CAPA_POOL_ID,
  isOwnerWithdrawal,
  type IndexedBurn,
} from "../src/capa-withdrawal.js";

// Blockscout's Polygon receipt for the source URL in the fixture. The Safe
// owned the LP tokens; Burn.sender and Burn.to were both the Router. This
// receipt also includes a Swap, which must not change burn attribution.
const owner = "0x3d54f9496bf5bd0afa67c80ee8bc2eeadf306381";
const row: IndexedBurn = {
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
const sourceReceipt = {
  ...receipt,
  blockNumber: 91215318n,
  logs: receipt.logs as unknown as Log[],
};

describe("LP withdrawal attribution", () => {
  it("matches the LP-token owner on a real burn-and-swap transaction", () => {
    expect(isOwnerWithdrawal(row, sourceReceipt, owner)).toBe(true);
  });

  it("does not mistake the Router, beneficiary, or another LP for the owner", () => {
    expect(
      isOwnerWithdrawal(
        row,
        sourceReceipt,
        "0x1eb1d6692057949d6129ee7742c53be019b22408",
      ),
    ).toBe(false);
    expect(
      isOwnerWithdrawal(
        row,
        sourceReceipt,
        "0x13a9803d547332c81ebc6060f739821264dbcf1e",
      ),
    ).toBe(false);
  });

  it("requires the exact successful burn and both LP-token transfers", () => {
    expect(
      isOwnerWithdrawal({ ...row, kind: "SWAP" }, sourceReceipt, owner),
    ).toBe(false);
    expect(
      isOwnerWithdrawal({ ...row, amount0: "1" }, sourceReceipt, owner),
    ).toBe(false);
    expect(
      isOwnerWithdrawal({ ...row, blockNumber: "1" }, sourceReceipt, owner),
    ).toBe(false);
    expect(
      isOwnerWithdrawal(
        { ...row, id: "137_91215318_840" },
        sourceReceipt,
        owner,
      ),
    ).toBe(false);
    expect(
      isOwnerWithdrawal(row, { ...sourceReceipt, status: "reverted" }, owner),
    ).toBe(false);
    expect(
      isOwnerWithdrawal(
        row,
        {
          ...sourceReceipt,
          logs: sourceReceipt.logs.filter((log) => log.logIndex !== 834),
        },
        owner,
      ),
    ).toBe(false);
    expect(
      isOwnerWithdrawal(
        row,
        {
          ...sourceReceipt,
          logs: sourceReceipt.logs.filter((log) => log.logIndex !== 835),
        },
        owner,
      ),
    ).toBe(false);
  });

  it("requires the exact chain/pool and transaction hash", () => {
    expect(
      isOwnerWithdrawal(
        { ...row, poolId: row.poolId.replace("137-", "143-") },
        sourceReceipt,
        owner,
      ),
    ).toBe(false);
    expect(
      isOwnerWithdrawal(
        row,
        { ...sourceReceipt, transactionHash: "0x" + "00".repeat(32) },
        owner,
      ),
    ).toBe(false);
  });
});
