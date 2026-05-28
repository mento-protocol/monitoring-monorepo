/**
 * Unit tests for QuickNode webhook payload envelope validation.
 *
 * QuickNode delivers payloads in a few shapes depending on the API era:
 * - Pre-template custom filter_function: `{ result: [...] }`.
 * - Template-based Webhooks envelope: `{ data: [...], metadata: {...} }`.
 * - evmContractEvents: `{ matchingReceipts: [...] }` with raw receipts.
 *
 * `validatePayload` accepts these shapes and normalizes to `result` so the
 * rest of the handler is shape-agnostic.
 */

import type { Request } from "@google-cloud/functions-framework";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "./logger";
import { validatePayload } from "./validate-payload";

vi.mock("./logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

function makeReq(body: unknown): Request {
  return { body } as unknown as Request;
}

const sampleLog = {
  address: "0x0000000000000000000000000000000000000001",
  name: "AddedOwner",
  transactionHash: "0x" + "a".repeat(64),
  blockHash: "0x" + "b".repeat(64),
  blockNumber: "0x1",
  logIndex: "0x0",
};

const safeMultiSigTransactionData = encodeAbiParameters(
  parseAbiParameters(
    "address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures,bytes additionalInfo",
  ),
  [
    "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
    0n,
    "0xa9059cbb0000000000000000000000001b20b200a78c6068ce5ea96226d1b53e0a119202000000000000000000000000000000000000000000000000000000517da02c00",
    0,
    0n,
    0n,
    0n,
    "0x0000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000000",
    "0x",
    "0x",
  ],
);

const sampleMatchingReceipt = {
  transactionHash:
    "0x96568e39858ca8130063bdc426ec4ed43c4fc2239d3e1cb6a3e91d063dce87b8",
  blockHash:
    "0x094f920c6aad435ce9cc7c6d68b9606eb6a87032aec4c27b789befdfc7343a5d",
  blockNumber: "0x40ea77a",
  logs: [
    {
      address: "0x655133d8e90f8190ed5c1f0f3710f602800c0150",
      blockHash:
        "0x094f920c6aad435ce9cc7c6d68b9606eb6a87032aec4c27b789befdfc7343a5d",
      blockNumber: "0x40ea77a",
      data: safeMultiSigTransactionData,
      logIndex: "0x7",
      topics: [
        "0x66753cd2356569ee081232e3be8909b950e0a76c1f8460c3a5e3c2be32b11bed",
      ],
      transactionHash:
        "0x96568e39858ca8130063bdc426ec4ed43c4fc2239d3e1cb6a3e91d063dce87b8",
    },
    {
      address: "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
      blockHash:
        "0x094f920c6aad435ce9cc7c6d68b9606eb6a87032aec4c27b789befdfc7343a5d",
      blockNumber: "0x40ea77a",
      data: "0x000000000000000000000000000000000000000000000000000000517da02c00",
      logIndex: "0x8",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      ],
      transactionHash:
        "0x96568e39858ca8130063bdc426ec4ed43c4fc2239d3e1cb6a3e91d063dce87b8",
    },
    {
      address: "0x655133d8e90f8190ed5c1f0f3710f602800c0150",
      data:
        "0xa8bd7e19090ccb95764fb84f08a105c661fd8b7a47620d57fe8ebc92f3230978" +
        "0000000000000000000000000000000000000000000000000000000000000000",
      logIndex: "0x9",
      topics: [
        "0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e",
      ],
    },
  ],
};

describe("validatePayload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts { result: [...] } envelope", () => {
    const result = validatePayload(makeReq({ result: [sampleLog] }));
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.payload.result).toEqual([sampleLog]);
  });

  it("accepts { data: [...] } envelope and normalizes to result", () => {
    const result = validatePayload(
      makeReq({ data: [sampleLog], metadata: { batchId: "x" } }),
    );
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.payload.result).toEqual([sampleLog]);
  });

  it("accepts { matchingReceipts: [...] } envelope and decodes Safe logs", () => {
    const result = validatePayload(
      makeReq({ matchingReceipts: [sampleMatchingReceipt] }),
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.result).toHaveLength(2);
      expect(result.payload.result[0]).toMatchObject({
        address: "0x655133d8e90f8190ed5c1f0f3710f602800c0150",
        name: "SafeMultiSigTransaction",
        transactionHash: sampleMatchingReceipt.transactionHash,
        blockHash: sampleMatchingReceipt.blockHash,
        blockNumber: sampleMatchingReceipt.blockNumber,
        logIndex: "0x7",
        to: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
        value: "0",
        operation: 0,
      });
      expect(result.payload.result[1]).toMatchObject({
        address: "0x655133d8e90f8190ed5c1f0f3710f602800c0150",
        name: "ExecutionSuccess",
        transactionHash: sampleMatchingReceipt.transactionHash,
        blockHash: sampleMatchingReceipt.blockHash,
        blockNumber: sampleMatchingReceipt.blockNumber,
        logIndex: "0x9",
        txHash:
          "0xa8bd7e19090ccb95764fb84f08a105c661fd8b7a47620d57fe8ebc92f3230978",
        payment: "0",
      });
      expect(logger.warn).not.toHaveBeenCalled();
    }
  });

  it("warns and drops decoded Safe logs that are missing required metadata", () => {
    const receiptWithMissingLogIndex = {
      ...sampleMatchingReceipt,
      logs: [
        {
          ...sampleMatchingReceipt.logs[0],
          logIndex: undefined,
        },
      ],
    };

    const result = validatePayload(
      makeReq({ matchingReceipts: [receiptWithMissingLogIndex] }),
    );

    expect(result.valid).toBe(true);
    if (result.valid) expect(result.payload.result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Dropping Safe log: missing required metadata fields",
      expect.objectContaining({
        address: "0x655133d8e90f8190ed5c1f0f3710f602800c0150",
        topic0:
          "0x66753cd2356569ee081232e3be8909b950e0a76c1f8460c3a5e3c2be32b11bed",
        hasTransactionHash: true,
        hasBlockHash: true,
        hasBlockNumber: true,
        hasLogIndex: false,
      }),
    );
  });

  it("warns and drops Safe ABI decode errors other than non-Safe topic misses", () => {
    const receiptWithMalformedSafeLog = {
      ...sampleMatchingReceipt,
      logs: [
        {
          ...sampleMatchingReceipt.logs[0],
          data: "0x1234",
        },
        sampleMatchingReceipt.logs[1],
      ],
    };

    const result = validatePayload(
      makeReq({ matchingReceipts: [receiptWithMalformedSafeLog] }),
    );

    expect(result.valid).toBe(true);
    if (result.valid) expect(result.payload.result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Unexpected error decoding log against Safe ABI",
      expect.objectContaining({
        address: "0x655133d8e90f8190ed5c1f0f3710f602800c0150",
        topic0:
          "0x66753cd2356569ee081232e3be8909b950e0a76c1f8460c3a5e3c2be32b11bed",
      }),
    );
  });

  it("prefers result over data when both are present", () => {
    const result = validatePayload(
      makeReq({ result: [sampleLog], data: ["wrong"] }),
    );
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.payload.result).toEqual([sampleLog]);
  });

  it("rejects payload with no supported event array", () => {
    const result = validatePayload(makeReq({ foo: "bar" }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.status).toBe(400);
  });

  it("rejects payload where result is not an array", () => {
    expect(validatePayload(makeReq({ result: "not-an-array" })).valid).toBe(
      false,
    );
  });

  it("rejects payload where data is not an array", () => {
    expect(validatePayload(makeReq({ data: { foo: 1 } })).valid).toBe(false);
  });

  it("rejects payload where matchingReceipts is not an array", () => {
    expect(
      validatePayload(makeReq({ matchingReceipts: { foo: 1 } })).valid,
    ).toBe(false);
  });

  it("rejects undefined / null body", () => {
    expect(validatePayload(makeReq(undefined)).valid).toBe(false);
    expect(validatePayload(makeReq(null)).valid).toBe(false);
  });

  it("accepts empty result array", () => {
    const result = validatePayload(makeReq({ result: [] }));
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.payload.result).toEqual([]);
  });

  it("accepts empty data array", () => {
    const result = validatePayload(makeReq({ data: [] }));
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.payload.result).toEqual([]);
  });

  it("accepts empty matchingReceipts array", () => {
    const result = validatePayload(makeReq({ matchingReceipts: [] }));
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.payload.result).toEqual([]);
  });
});
