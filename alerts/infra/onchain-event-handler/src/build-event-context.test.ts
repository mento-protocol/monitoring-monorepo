/**
 * Unit tests for event context building
 */

import { describe, expect, it } from "vitest";
import { buildEventContext } from "./build-event-context";
import type { QuickNodeWebhookPayload } from "./types";

describe("buildEventContext", () => {
  it("should build txHashMap from ExecutionSuccess events", () => {
    const logs: QuickNodeWebhookPayload["result"] = [
      {
        address: "0x123",
        name: "ExecutionSuccess",
        transactionHash: "0xtx1",
        blockHash: "0xblock1",
        blockNumber: "100",
        logIndex: "0",
        txHash: "0xsafeTx1",
      },
      {
        address: "0x123",
        name: "ExecutionSuccess",
        transactionHash: "0xtx2",
        blockHash: "0xblock2",
        blockNumber: "101",
        logIndex: "1",
        txHash: "0xsafeTx2",
      },
    ];

    const context = buildEventContext(logs);

    expect(context.txHashMap.size).toBe(2);
    expect(context.txHashMap.get("0xtx1")).toBe("0xsafeTx1");
    expect(context.txHashMap.get("0xtx2")).toBe("0xsafeTx2");
  });

  it("should track SafeMultiSigTransaction events", () => {
    const logs: QuickNodeWebhookPayload["result"] = [
      {
        address: "0x123",
        name: "SafeMultiSigTransaction",
        transactionHash: "0xtx1",
        blockHash: "0xblock1",
        blockNumber: "100",
        logIndex: "0",
      },
      {
        address: "0x123",
        name: "SafeMultiSigTransaction",
        transactionHash: "0xtx2",
        blockHash: "0xblock2",
        blockNumber: "101",
        logIndex: "1",
      },
    ];

    const context = buildEventContext(logs);

    expect(context.hasSafeMultiSigTx.size).toBe(2);
    expect(context.hasSafeMultiSigTx.has("0xtx1")).toBe(true);
    expect(context.hasSafeMultiSigTx.has("0xtx2")).toBe(true);
  });

  it("should handle empty logs", () => {
    const logs: QuickNodeWebhookPayload["result"] = [];

    const context = buildEventContext(logs);

    expect(context.txHashMap.size).toBe(0);
    expect(context.hasSafeMultiSigTx.size).toBe(0);
  });

  it("should handle logs without ExecutionSuccess or SafeMultiSigTransaction", () => {
    const logs: QuickNodeWebhookPayload["result"] = [
      {
        address: "0x123",
        name: "AddedOwner",
        transactionHash: "0xtx1",
        blockHash: "0xblock1",
        blockNumber: "100",
        logIndex: "0",
      },
    ];

    const context = buildEventContext(logs);

    expect(context.txHashMap.size).toBe(0);
    expect(context.hasSafeMultiSigTx.size).toBe(0);
  });

  it("should handle ExecutionSuccess without txHash", () => {
    const logs: QuickNodeWebhookPayload["result"] = [
      {
        address: "0x123",
        name: "ExecutionSuccess",
        transactionHash: "0xtx1",
        blockHash: "0xblock1",
        blockNumber: "100",
        logIndex: "0",
        // No txHash field
      },
    ];

    const context = buildEventContext(logs);

    expect(context.txHashMap.size).toBe(0);
  });
});
