import { describe, expect, it } from "vitest";
import {
  isRoutablePoolId,
  routeCanonicalPoolId,
} from "../route-canonicalization";

describe("pool route canonicalization", () => {
  it("keeps bare addresses raw so the client network selects the chain", () => {
    expect(
      routeCanonicalPoolId("0xAaa0000000000000000000000000000000000001"),
    ).toBe("0xaaa0000000000000000000000000000000000001");
  });

  it("lowercases namespaced ids without changing the chain prefix", () => {
    expect(
      routeCanonicalPoolId("10143-0xAaa0000000000000000000000000000000000001"),
    ).toBe("10143-0xaaa0000000000000000000000000000000000001");
  });

  it("marks raw addresses and namespaced ids as routable", () => {
    expect(isRoutablePoolId("0xaaa0000000000000000000000000000000000001")).toBe(
      true,
    );
    expect(
      isRoutablePoolId("42220-0xaaa0000000000000000000000000000000000001"),
    ).toBe(true);
  });

  it("leaves malformed ids for the not-found redirect gate", () => {
    expect(routeCanonicalPoolId("not-a-pool")).toBe("not-a-pool");
    expect(isRoutablePoolId("not-a-pool")).toBe(false);
  });
});
