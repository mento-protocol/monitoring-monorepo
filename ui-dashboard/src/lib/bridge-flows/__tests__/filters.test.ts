import { describe, expect, it } from "vitest";
import {
  buildBridgeTransferWhere,
  parseBridgeChainId,
} from "@/lib/bridge-flows/filters";

describe("bridge transfer filters", () => {
  it("builds one predicate shared by the row and count queries", () => {
    expect(buildBridgeTransferWhere(["SENT"], 137, 42220)).toEqual({
      status: { _in: ["SENT"] },
      sourceChainId: { _eq: 137 },
      destChainId: { _eq: 42220 },
    });
  });

  it("omits direction predicates for the all-chains view", () => {
    expect(
      buildBridgeTransferWhere(["PENDING", "DELIVERED"], null, null),
    ).toEqual({
      status: { _in: ["PENDING", "DELIVERED"] },
    });
  });

  it("accepts only exact configured chain IDs", () => {
    const allowed = new Set([42220, 143, 137]);
    expect(parseBridgeChainId("137", allowed)).toBe(137);
    expect(parseBridgeChainId("0137", allowed)).toBe(137);
    expect(parseBridgeChainId("80002", allowed)).toBeNull();
    expect(parseBridgeChainId("137x", allowed)).toBeNull();
    expect(parseBridgeChainId(null, allowed)).toBeNull();
  });
});
