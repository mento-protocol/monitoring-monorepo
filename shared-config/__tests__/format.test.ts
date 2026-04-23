import { describe, it, expect } from "vitest";
import { poolIdAddress, shortAddress } from "../src/format";

describe("poolIdAddress", () => {
  it("extracts the address after the first dash", () => {
    expect(poolIdAddress("42220-0xdeadbeef")).toBe("0xdeadbeef");
  });

  it("takes the first dash only (later dashes stay part of the address)", () => {
    expect(poolIdAddress("143-0xabc-suffix")).toBe("0xabc-suffix");
  });

  it("returns the input unchanged when no dash is present", () => {
    expect(poolIdAddress("0xbare")).toBe("0xbare");
  });

  it("returns empty string for empty input", () => {
    expect(poolIdAddress("")).toBe("");
  });

  it("returns empty string when the pool id ends with a dash", () => {
    expect(poolIdAddress("42220-")).toBe("");
  });
});

describe("shortAddress", () => {
  it("truncates a full 42-char address", () => {
    expect(shortAddress("0x93e15a22fda39fefccce82d387a09ccf030ead61")).toBe(
      "0x93e1…ad61",
    );
  });

  it("returns non-0x-prefixed input unchanged", () => {
    expect(shortAddress("not-an-address")).toBe("not-an-address");
  });

  it("returns short 0x input unchanged (below 12-char threshold)", () => {
    expect(shortAddress("0xab")).toBe("0xab");
  });

  it("returns the 11-char boundary unchanged", () => {
    expect(shortAddress("0x123456789")).toBe("0x123456789");
  });

  it("truncates at the 12-char boundary", () => {
    expect(shortAddress("0x1234567890")).toBe("0x1234…7890");
  });

  it("returns empty input unchanged", () => {
    expect(shortAddress("")).toBe("");
  });
});
