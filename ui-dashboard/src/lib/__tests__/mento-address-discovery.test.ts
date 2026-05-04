import { describe, it, expect, vi, beforeEach } from "vitest";

const requestMock = vi.fn();

vi.mock("graphql-request", () => ({
  GraphQLClient: class {
    request = requestMock;
  },
}));

import { discoverMentoAddresses } from "@/lib/mento-address-discovery";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("discoverMentoAddresses", () => {
  // 40-hex shape so isValidAddress accepts it.
  const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

  it("aggregates addresses across every entity + field", async () => {
    // 12 (entity, field) pairs total; one query per pair with dedup overlap.
    const responses = [
      [A(0xaaa)], // SwapEvent.sender
      [A(0xbbb)], // SwapEvent.recipient
      [A(0x444)], // SwapEvent.caller
      [A(0x555)], // SwapEvent.txTo
      [A(0xaaa)], // LiquidityEvent.sender (dedup)
      [A(0xccc)], // LiquidityEvent.recipient
      [A(0xddd)], // RebalanceEvent.sender
      [A(0xeee)], // RebalanceEvent.caller
      [A(0xfff)], // LiquidityPosition.address
      [A(0x111)], // OlsLiquidityEvent.caller
      [A(0x222)], // BridgeTransfer.sender
      [A(0x333)], // BridgeTransfer.recipient
    ];
    let i = 0;
    requestMock.mockImplementation(async () => {
      const addresses = responses[i++] ?? [];
      return { rows: addresses.map((address) => ({ address })) };
    });

    const result = await discoverMentoAddresses(
      "https://hasura/graphql",
      42220,
    );
    // 11 unique addresses (A(0xaaa) duplicated).
    expect(result.addresses).toHaveLength(11);
    expect(result.addresses).toContain(A(0xaaa));
    expect(result.addresses).toContain(A(0x333));
    expect(result.addresses).toContain(A(0x444));
    expect(result.addresses).toContain(A(0x555));
    expect(result.perEntity).toHaveLength(12);
  });

  it("filters out malformed addresses", async () => {
    let i = 0;
    requestMock.mockImplementation(async () => {
      i += 1;
      if (i === 1) {
        return {
          rows: [
            { address: A(0x1) }, // valid
            { address: "" }, // empty
            { address: "0xnotanaddress" }, // wrong length
            { address: A(0x2) }, // valid
          ],
        };
      }
      return { rows: [] };
    });

    const result = await discoverMentoAddresses(
      "https://hasura/graphql",
      42220,
    );
    expect(result.addresses).toEqual([A(0x1), A(0x2)]);
  });

  it("paginates past the 1000-row Hasura cap", async () => {
    let calls = 0;
    requestMock.mockImplementation(async () => {
      calls += 1;
      // Return a full page on the first call, empty on the second so the
      // pager exits after picking up the first batch.
      if (calls === 1) {
        return {
          rows: Array.from({ length: 1000 }, (_, i) => ({
            address: `0x${i.toString(16).padStart(40, "0")}`,
          })),
        };
      }
      return { rows: [] };
    });

    await discoverMentoAddresses("https://hasura/graphql", 42220);
    // 12 (entity, field) pairs total. Without pagination we'd see exactly
    // 12 calls; the first pair returning a full page forces an extra call,
    // so > 12 confirms the pager kicked in.
    expect(calls).toBeGreaterThan(12);
  });

  it("lowercases addresses and dedups", async () => {
    const upper = "0x" + "A".repeat(40);
    const lower = upper.toLowerCase();
    requestMock.mockImplementation(async () => ({
      rows: [{ address: upper }, { address: lower }],
    }));
    const result = await discoverMentoAddresses(
      "https://hasura/graphql",
      42220,
    );
    // Mixed-case duplicates collapse to a single lowercase entry.
    expect(result.addresses.filter((a) => a === lower)).toHaveLength(1);
  });
});
