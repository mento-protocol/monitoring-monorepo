import { describe, expect, it } from "vitest";
import {
  isRoutablePoolId,
  parseRouteChainId,
  routeCanonicalPoolId,
} from "../route-canonicalization";

describe("pool route chain context", () => {
  it("parses positive integer chain ids", () => {
    expect(parseRouteChainId("143")).toBe(143);
    expect(parseRouteChainId(["42220", "143"])).toBe(42220);
  });

  it("rejects missing, malformed, zero, and unsafe chain ids", () => {
    expect(parseRouteChainId(undefined)).toBeNull();
    expect(parseRouteChainId("")).toBeNull();
    expect(parseRouteChainId("143.5")).toBeNull();
    expect(parseRouteChainId("0")).toBeNull();
    expect(parseRouteChainId(String(Number.MAX_SAFE_INTEGER + 1))).toBeNull();
  });
});

describe("pool route canonicalization", () => {
  it("keeps bare addresses raw when no explicit chain context exists", () => {
    expect(
      routeCanonicalPoolId("0xAaa0000000000000000000000000000000000001", null),
    ).toBe("0xAaa0000000000000000000000000000000000001");
  });

  it("namespaces bare addresses when explicit chain context exists", () => {
    expect(
      routeCanonicalPoolId("0xAaa0000000000000000000000000000000000001", 143),
    ).toBe("143-0xaaa0000000000000000000000000000000000001");
  });

  it("lowercases namespaced ids without changing the chain prefix", () => {
    expect(
      routeCanonicalPoolId(
        "10143-0xAaa0000000000000000000000000000000000001",
        143,
      ),
    ).toBe("10143-0xaaa0000000000000000000000000000000000001");
  });

  it("only marks namespaced ids as routable", () => {
    expect(isRoutablePoolId("0xaaa0000000000000000000000000000000000001")).toBe(
      false,
    );
    expect(
      isRoutablePoolId("42220-0xaaa0000000000000000000000000000000000001"),
    ).toBe(true);
  });

  it("leaves malformed ids for the not-found redirect gate", () => {
    expect(routeCanonicalPoolId("not-a-pool", 42220)).toBe("not-a-pool");
    expect(isRoutablePoolId("not-a-pool")).toBe(false);
  });
});
