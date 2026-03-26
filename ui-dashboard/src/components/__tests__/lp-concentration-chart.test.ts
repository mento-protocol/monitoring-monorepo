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
    expect(resolvePieLabel(ADDR, () => "Team Wallet")).toBe("Team Wallet");
  });

  it("returns truncated address when getLabel returns the truncated form", () => {
    const getLabel = (address: string) => truncateAddress(address) ?? address;
    expect(resolvePieLabel(ADDR, getLabel)).toBe(truncateAddress(ADDR));
  });

  it("does not include raw address when a named label exists", () => {
    const result = resolvePieLabel(ADDR, () => "Team Wallet");
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
    expect(resolvePieLabel(ADDR, () => "Shared Label")).toBe("Shared Label");
    expect(resolvePieLabel(ADDR2, () => "Shared Label")).toBe("Shared Label");
  });
});
