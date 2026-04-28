import { describe, it, expect, vi, beforeEach } from "vitest";

const requestMock = vi.fn();

vi.mock("graphql-request", () => ({
  GraphQLClient: class {
    request = requestMock;
  },
}));

import { discoverMentoAddresses } from "@/lib/arkham-discovery";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("discoverMentoAddresses", () => {
  it("rejects unsupported chain ids", async () => {
    await expect(
      discoverMentoAddresses("https://hasura/graphql", 143),
    ).rejects.toThrow(/not supported by Arkham/);
  });

  it("aggregates addresses across every entity + field", async () => {
    // 10 (entity, field) pairs total; one query per pair with dedup overlap.
    const responses = [
      ["0xaaa"], // SwapEvent.sender
      ["0xbbb"], // SwapEvent.recipient
      ["0xaaa"], // LiquidityEvent.sender (dedup)
      ["0xccc"], // LiquidityEvent.recipient
      ["0xddd"], // RebalanceEvent.sender
      ["0xeee"], // RebalanceEvent.caller
      ["0xfff"], // LiquidityPosition.address
      ["0x111"], // OlsLiquidityEvent.caller
      ["0x222"], // BridgeTransfer.sender
      ["0x333"], // BridgeTransfer.recipient
    ];
    let i = 0;
    requestMock.mockImplementation(async () => {
      const addresses = responses[i++] ?? [];
      return { rows: addresses.map((address) => ({ address })) };
    });

    const result = await discoverMentoAddresses("https://hasura/graphql", 42220);
    // 9 unique addresses (0xaaa duplicated).
    expect(result.addresses).toHaveLength(9);
    expect(result.addresses).toContain("0xaaa");
    expect(result.addresses).toContain("0x333");
    expect(result.perEntity.length).toBeGreaterThan(0);
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
    // 10 (entity, field) pairs total. Without pagination we'd see exactly
    // 10 calls; the first pair returning a full page forces an extra call,
    // so > 10 confirms the pager kicked in.
    expect(calls).toBeGreaterThan(10);
  });

  it("lowercases addresses and dedups", async () => {
    requestMock.mockImplementation(async () => ({
      rows: [{ address: "0xABC" }, { address: "0xabc" }, { address: "0xABCdef" }],
    }));
    const result = await discoverMentoAddresses(
      "https://hasura/graphql",
      42220,
    );
    expect(result.addresses).toContain("0xabc");
    expect(result.addresses).toContain("0xabcdef");
    // Should NOT contain mixed-case duplicates.
    expect(result.addresses.filter((a) => a === "0xabc")).toHaveLength(1);
  });
});
