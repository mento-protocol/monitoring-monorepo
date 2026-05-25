/**
 * Unit tests for QuickNode webhook payload envelope validation.
 *
 * QuickNode delivers payloads in two shapes depending on the API era:
 * - Pre-template custom filter_function: `{ result: [...] }` (the filter
 *   function explicitly constructed this).
 * - Template-based (evmContractEvents, evmAbiFilter, etc.): may deliver
 *   `{ data: [...], metadata: {...} }` per the Webhooks envelope.
 *
 * `validatePayload` accepts either and normalizes to `result` so the rest
 * of the handler is shape-agnostic. These tests pin both happy paths plus
 * the rejection cases.
 */

import type { Request } from "@google-cloud/functions-framework";
import { describe, expect, it, vi } from "vitest";
import { validatePayload } from "./validate-payload";

// Minimal Request mock — only `.body` is read; tests don't exercise headers
// or other Express fields here.
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

describe("validatePayload", () => {
  it("accepts { result: [...] } envelope (custom filter_function era)", () => {
    const result = validatePayload(makeReq({ result: [sampleLog] }));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.result).toEqual([sampleLog]);
    }
  });

  it("accepts { data: [...] } envelope (template era) and normalizes to result", () => {
    const result = validatePayload(
      makeReq({ data: [sampleLog], metadata: { batchId: "x" } }),
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      // Normalized to canonical `result` shape — downstream code doesn't
      // need to branch on envelope type.
      expect(result.payload.result).toEqual([sampleLog]);
    }
  });

  it("prefers result over data when both are present", () => {
    const result = validatePayload(
      makeReq({ result: [sampleLog], data: ["wrong"] }),
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.result).toEqual([sampleLog]);
    }
  });

  it("rejects payload with neither result nor data array", () => {
    const result = validatePayload(makeReq({ foo: "bar" }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.status).toBe(400);
    }
  });

  it("rejects payload where result is not an array", () => {
    const result = validatePayload(makeReq({ result: "not-an-array" }));
    expect(result.valid).toBe(false);
  });

  it("rejects payload where data is not an array", () => {
    const result = validatePayload(makeReq({ data: { foo: 1 } }));
    expect(result.valid).toBe(false);
  });

  it("rejects undefined / null body", () => {
    expect(validatePayload(makeReq(undefined)).valid).toBe(false);
    expect(validatePayload(makeReq(null)).valid).toBe(false);
  });

  it("accepts empty result array (no events matched)", () => {
    const result = validatePayload(makeReq({ result: [] }));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.result).toEqual([]);
    }
  });

  it("accepts empty data array (no events matched, template era)", () => {
    const result = validatePayload(makeReq({ data: [] }));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.result).toEqual([]);
    }
  });

  // Suppress logger.error noise in test output. The handler's logger
  // writes to stdout; explicit silencing keeps `pnpm test` clean.
  vi.mock("./logger", () => ({
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  }));
});
