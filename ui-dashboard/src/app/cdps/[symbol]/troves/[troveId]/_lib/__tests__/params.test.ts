import { describe, expect, it } from "vitest";
import {
  CDP_TROVE_OPERATIONS_RENDER_LIMIT,
  CDP_TROVE_OPERATIONS_REQUEST_LIMIT,
  isValidTroveIdParam,
  makeTroveEntityId,
  normalizeTroveIdParam,
  paginateTroveOperations,
} from "../params";

describe("isValidTroveIdParam", () => {
  it("accepts a 0x-prefixed hex id of any length up to 64 digits", () => {
    expect(isValidTroveIdParam("0x1")).toBe(true);
    expect(isValidTroveIdParam("0xabcDEF0123456789")).toBe(true);
    expect(isValidTroveIdParam(`0x${"f".repeat(64)}`)).toBe(true);
  });

  it("rejects garbage: missing prefix, non-hex chars, empty, too long", () => {
    expect(isValidTroveIdParam("1")).toBe(false);
    expect(isValidTroveIdParam("0xzz")).toBe(false);
    expect(isValidTroveIdParam("")).toBe(false);
    expect(isValidTroveIdParam("0x")).toBe(false);
    expect(isValidTroveIdParam(`0x${"f".repeat(65)}`)).toBe(false);
    expect(isValidTroveIdParam("not-an-id")).toBe(false);
  });
});

describe("normalizeTroveIdParam", () => {
  it("lowercases to match the indexer's stored casing", () => {
    expect(normalizeTroveIdParam("0xABCdef")).toBe("0xabcdef");
  });

  it("strips leading zeros to match the indexer's toString(16) storage", () => {
    // The indexer stores `0x${troveId.toString(16)}` — a padded 32-byte ABI
    // form of the same uint256 must normalize to the identical unpadded id,
    // or the entity lookup misses and the trove reads as "not indexed".
    expect(normalizeTroveIdParam("0x0000000000000000000000000000000001")).toBe(
      "0x1",
    );
    expect(normalizeTroveIdParam("0x000abc")).toBe("0xabc");
  });

  it("collapses an all-zero id to 0x0, matching bigint.toString(16)", () => {
    expect(normalizeTroveIdParam("0x000")).toBe("0x0");
  });

  it("is idempotent on an already-normalized id", () => {
    expect(normalizeTroveIdParam("0x1")).toBe("0x1");
    expect(normalizeTroveIdParam("0xabc")).toBe("0xabc");
  });
});

describe("makeTroveEntityId", () => {
  it("mirrors the indexer's makeTroveId composite key", () => {
    expect(makeTroveEntityId("gbpm", "0x8abc")).toBe("gbpm-0x8abc");
  });
});

describe("paginateTroveOperations", () => {
  function rows(n: number): number[] {
    // Simulated desc-ordered fetch: newest (highest) first.
    return Array.from({ length: n }, (_, i) => n - i);
  }

  it("is not truncated and reverses to chronological order when under the render limit", () => {
    const result = paginateTroveOperations(rows(3), 5);
    expect(result.truncated).toBe(false);
    expect(result.rows).toEqual([1, 2, 3]);
  });

  it("is not truncated when the fetch returns exactly the render limit", () => {
    const result = paginateTroveOperations(rows(5), 5);
    expect(result.truncated).toBe(false);
    expect(result.rows).toHaveLength(5);
  });

  it("is truncated only when the sentinel (limit+1) row comes back, and drops it", () => {
    const result = paginateTroveOperations(rows(6), 5);
    expect(result.truncated).toBe(true);
    // Oldest row (id 1) is the dropped sentinel; kept rows are 2..6,
    // reversed to chronological order.
    expect(result.rows).toEqual([2, 3, 4, 5, 6]);
    expect(result.rows).not.toContain(1);
  });

  it("defaults to the shared render limit", () => {
    const result = paginateTroveOperations(
      rows(CDP_TROVE_OPERATIONS_REQUEST_LIMIT),
    );
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(CDP_TROVE_OPERATIONS_RENDER_LIMIT);
  });
});
