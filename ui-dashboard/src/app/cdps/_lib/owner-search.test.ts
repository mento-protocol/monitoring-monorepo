import { describe, expect, it } from "vitest";
import {
  CDP_OWNER_SEARCH_RENDER_LIMIT,
  CDP_OWNER_SEARCH_REQUEST_LIMIT,
  CdpTrovesByOwnerSchema,
  isValidOwnerSearchAddress,
  normalizeOwnerSearchInput,
  paginateOwnerSearchRows,
  shortenTroveId,
  type CdpOwnerTroveRow,
} from "./owner-search";

function hit(overrides: Partial<CdpOwnerTroveRow> = {}): CdpOwnerTroveRow {
  return {
    id: "42220-0xmanager-0x1",
    collateralId: "42220-0xmanager",
    troveId: "0x1",
    status: "active",
    debt: "1000000000000000000",
    coll: "2000000000000000000",
    lastUpdatedAt: "1767225600",
    ...overrides,
  };
}

describe("normalizeOwnerSearchInput", () => {
  it("trims and lowercases to the indexer's stored address form", () => {
    expect(
      normalizeOwnerSearchInput(
        "  0xCCA0A99B94529493dDffE7c61A3AE454828cD3Bb ",
      ),
    ).toBe("0xcca0a99b94529493ddffe7c61a3ae454828cd3bb");
    expect(normalizeOwnerSearchInput("   ")).toBe("");
  });
});

describe("isValidOwnerSearchAddress", () => {
  it("accepts a full normalized 20-byte hex address", () => {
    expect(
      isValidOwnerSearchAddress("0xcca0a99b94529493ddffe7c61a3ae454828cd3bb"),
    ).toBe(true);
  });

  it("rejects partial, overlong, non-hex, and unprefixed input", () => {
    expect(isValidOwnerSearchAddress("")).toBe(false);
    expect(isValidOwnerSearchAddress("0xcca0")).toBe(false);
    expect(
      isValidOwnerSearchAddress("0xcca0a99b94529493ddffe7c61a3ae454828cd3bb0"),
    ).toBe(false);
    expect(
      isValidOwnerSearchAddress("0xzza0a99b94529493ddffe7c61a3ae454828cd3bb"),
    ).toBe(false);
    expect(
      isValidOwnerSearchAddress("cca0a99b94529493ddffe7c61a3ae454828cd3bb"),
    ).toBe(false);
  });

  it("rejects the zero address — never-transferred troves hold it as previousOwner", () => {
    expect(isValidOwnerSearchAddress(`0x${"0".repeat(40)}`)).toBe(false);
  });
});

describe("paginateOwnerSearchRows", () => {
  it("request limit is exactly render limit + 1 (the sentinel)", () => {
    expect(CDP_OWNER_SEARCH_REQUEST_LIMIT).toBe(
      CDP_OWNER_SEARCH_RENDER_LIMIT + 1,
    );
  });

  it("a result of exactly the render limit is complete, not capped", () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      hit({ id: `row-${i}`, troveId: `0x${i + 1}` }),
    );
    expect(paginateOwnerSearchRows(rows, 3)).toEqual({ rows, capped: false });

    const underLimit = rows.slice(0, 2);
    expect(paginateOwnerSearchRows(underLimit, 3)).toEqual({
      rows: underLimit,
      capped: false,
    });
  });

  it("drops the sentinel row and flags the cap only when it came back", () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      hit({ id: `row-${i}`, troveId: `0x${i + 1}` }),
    );
    const page = paginateOwnerSearchRows(rows, 3);
    expect(page.capped).toBe(true);
    expect(page.rows).toHaveLength(3);
    expect(page.rows.map((r) => r.id)).toEqual(["row-0", "row-1", "row-2"]);
  });
});

describe("shortenTroveId", () => {
  it("passes short ids through and middle-ellipsizes long ones", () => {
    expect(shortenTroveId("0x1")).toBe("0x1");
    expect(shortenTroveId("0x1234567890a")).toBe("0x1234567890a");
    const long =
      "0x5f23a9b8f4c249163a0d7969d2fc23af8de9e84d3f63b44136bfd18ea3e73ac4";
    expect(shortenTroveId(long)).toBe("0x5f23…3ac4");
  });
});

describe("CdpTrovesByOwnerSchema", () => {
  it("accepts a well-formed response", () => {
    expect(CdpTrovesByOwnerSchema.safeParse({ Trove: [hit()] }).success).toBe(
      true,
    );
    expect(CdpTrovesByOwnerSchema.safeParse({ Trove: [] }).success).toBe(true);
  });

  it("rejects rows drifted away from the selected shape", () => {
    const withoutTroveId: Partial<CdpOwnerTroveRow> = hit();
    delete withoutTroveId.troveId;
    expect(
      CdpTrovesByOwnerSchema.safeParse({ Trove: [withoutTroveId] }).success,
    ).toBe(false);
    expect(
      CdpTrovesByOwnerSchema.safeParse({
        Trove: [hit({ debt: 5 as unknown as string })],
      }).success,
    ).toBe(false);
  });
});
