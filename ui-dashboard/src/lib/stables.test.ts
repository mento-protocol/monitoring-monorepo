import { describe, expect, it } from "vitest";
import { displayLabel, isMintKind, kindLabel } from "./stables";

describe("displayLabel", () => {
  it("appends `· v3` suffix when source is V3_HUB_COLLATERAL and symbol is USDm", () => {
    expect(displayLabel("USDm", "V3_HUB_COLLATERAL")).toBe("USDm · v3");
  });

  it("passes V2 USDm through unchanged", () => {
    expect(displayLabel("USDm", "V2_RESERVE")).toBe("USDm");
  });

  it("does NOT add the · v3 suffix for non-USDm symbols even on V3_HUB_COLLATERAL", () => {
    // Defensive — there's only one V3 hub token today (USDm), but if a
    // future V3 hub stable lands with a non-USDm symbol the suffix
    // shouldn't fire.
    expect(displayLabel("EURm", "V3_HUB_COLLATERAL")).toBe("EURm");
  });

  it("applies the cEUR → EURm legacy alias on V2_RESERVE", () => {
    expect(displayLabel("cEUR", "V2_RESERVE")).toBe("EURm");
  });

  it("V3_LIQUITY tokens pass through unchanged (GBPm/CHFm/JPYm aren't aliased)", () => {
    expect(displayLabel("GBPm", "V3_LIQUITY")).toBe("GBPm");
    expect(displayLabel("CHFm", "V3_LIQUITY")).toBe("CHFm");
    expect(displayLabel("JPYm", "V3_LIQUITY")).toBe("JPYm");
  });
});

describe("isMintKind", () => {
  it("identifies mint kinds across all three sources", () => {
    expect(isMintKind("RESERVE_MINT")).toBe(true);
    expect(isMintKind("BRIDGE_MINT")).toBe(true);
    expect(isMintKind("OTHER_MINT")).toBe(true);
  });

  it("identifies burn kinds across all three sources", () => {
    expect(isMintKind("RESERVE_BURN")).toBe(false);
    expect(isMintKind("BRIDGE_BURN")).toBe(false);
    expect(isMintKind("OTHER_BURN")).toBe(false);
  });
});

describe("kindLabel", () => {
  it("renders human-readable labels for every kind enum value", () => {
    expect(kindLabel("RESERVE_MINT")).toBe("Reserve mint");
    expect(kindLabel("RESERVE_BURN")).toBe("Reserve burn");
    expect(kindLabel("BRIDGE_MINT")).toBe("Bridge mint");
    expect(kindLabel("BRIDGE_BURN")).toBe("Bridge burn");
    expect(kindLabel("OTHER_MINT")).toBe("Mint");
    expect(kindLabel("OTHER_BURN")).toBe("Burn");
  });
});
