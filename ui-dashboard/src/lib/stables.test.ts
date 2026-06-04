import { describe, expect, it } from "vitest";
import { formatWei } from "./format";
import {
  displayLabel,
  effectiveOracleRate,
  isMintKind,
  kindLabel,
} from "./stables";

describe("displayLabel", () => {
  it("appends `· v3` suffix when source is V3_HUB_COLLATERAL and symbol is USDm", () => {
    expect(displayLabel("USDm", "V3_HUB_COLLATERAL")).toBe("USDm · v3");
  });

  it("passes reserve USDm through unchanged", () => {
    expect(displayLabel("USDm", "RESERVE")).toBe("USDm");
  });

  it("does NOT add the · v3 suffix for non-USDm symbols even on V3_HUB_COLLATERAL", () => {
    // Defensive — there's only one V3 hub token today (USDm), but if a
    // future V3 hub stable lands with a non-USDm symbol the suffix
    // shouldn't fire.
    expect(displayLabel("EURm", "V3_HUB_COLLATERAL")).toBe("EURm");
  });

  it("applies the cEUR → EURm legacy alias on RESERVE", () => {
    expect(displayLabel("cEUR", "RESERVE")).toBe("EURm");
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

describe("effectiveOracleRate", () => {
  it("returns the direct oracle rate when present", () => {
    const rates = new Map([["EURm", 1.1]]);
    expect(effectiveOracleRate(rates, "EURm")).toBe(1.1);
  });

  it("prefers a chain-qualified oracle rate when present", () => {
    const rates = new Map([
      ["EURm", 1.1],
      ["143:EURm", 1.08],
    ]);
    expect(effectiveOracleRate(rates, "EURm", 143)).toBe(1.08);
  });

  it("defaults USDm to 1.0 when the oracle map has no entry", () => {
    // `useOracleRates`/`buildOracleRateMap` derives non-USDm rates from
    // USDm pairs and never emits USDm itself, so this fallback is
    // required for USDm to participate in the total + stacked chart.
    expect(effectiveOracleRate(new Map(), "USDm")).toBe(1);
  });

  it("defaults other USD-pegged symbols to 1.0", () => {
    expect(effectiveOracleRate(new Map(), "cUSD")).toBe(1);
    expect(effectiveOracleRate(new Map(), "USDC")).toBe(1);
  });

  it("returns null for non-USD-pegged symbols without a rate", () => {
    expect(effectiveOracleRate(new Map(), "EURm")).toBeNull();
    expect(effectiveOracleRate(new Map(), "BRLm")).toBeNull();
  });

  it("direct rate takes precedence over USD-pegged default", () => {
    // Defensive: if the oracle ever produced a USDm rate slightly off
    // from 1.0 (e.g. depeg signal), we honor it rather than overriding.
    const rates = new Map([["USDm", 0.997]]);
    expect(effectiveOracleRate(rates, "USDm")).toBe(0.997);
  });
});

describe("StableSupplyChangeEvent.tokenDecimals → formatWei contract", () => {
  // The changes table feeds `event.tokenDecimals` (denormalized from
  // STABLES.decimals indexer-side) into `formatWei`. tracked
  // stable is 18-decimal; this test locks the contract for any future
  // non-18 Mento stable (e.g. a 6-dp USDC-bridged variant). Without it,
  // a regression that hardcoded 18 again would silently underrender
  // by 10^N for non-18 stables — exactly the bug this denormalization
  // exists to prevent.
  it("formats 1 token at 18 decimals (current tracked stables)", () => {
    expect(formatWei("1000000000000000000", 18, 2)).toBe("1.00");
  });

  it("formats 1.234567 token at 6 decimals (USDC-shaped fixture)", () => {
    expect(formatWei("1234567", 6, 2)).toBe("1.23");
  });

  it("formats 0.5 token at 6 decimals", () => {
    expect(formatWei("500000", 6, 2)).toBe("0.50");
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
