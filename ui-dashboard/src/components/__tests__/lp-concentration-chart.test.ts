import { describe, expect, it } from "vitest";
import { resolvePieLabel } from "@/components/lp-concentration-chart";
import { truncateAddress } from "@/lib/format";

const ADDR = "0x10158838fa2ded977b8bf175ea69d17a715371c0";
const ADDR2 = "0xd363dab93e4ded977b8bf175ea69d17a715371c1";

describe("resolvePieLabel", () => {
  it("returns truncated address when no getLabel provided", () => {
    expect(resolvePieLabel(ADDR)).toBe(truncateAddress(ADDR));
  });

  it("returns named label when getLabel resolves a real name", () => {
    const getLabel = (_address: string) => "Team Wallet";
    expect(resolvePieLabel(ADDR, getLabel)).toBe("Team Wallet");
  });

  it("returns truncated address when getLabel returns the truncated form", () => {
    const getLabel = (address: string) => truncateAddress(address) ?? address;
    expect(resolvePieLabel(ADDR, getLabel)).toBe(truncateAddress(ADDR));
  });

  it("does not include raw address when a named label exists", () => {
    const getLabel = (_address: string) => "Team Wallet";
    const result = resolvePieLabel(ADDR, getLabel);
    expect(result).not.toContain("0x1015");
    expect(result).toBe("Team Wallet");
  });

  it("does not duplicate unlabelled addresses", () => {
    const getLabel = (address: string) => truncateAddress(address) ?? address;
    const result = resolvePieLabel(ADDR, getLabel);
    expect(result).not.toBe(ADDR);
    expect(result).toBe(truncateAddress(ADDR));
  });

  it("allows multiple addresses to resolve to the same human label", () => {
    const getLabel = (_address: string) => "Shared Label";
    expect(resolvePieLabel(ADDR, getLabel)).toBe("Shared Label");
    expect(resolvePieLabel(ADDR2, getLabel)).toBe("Shared Label");
  });
});
