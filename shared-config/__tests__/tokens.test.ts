import { describe, it, expect } from "vitest";
import {
  tokenSymbol,
  poolName,
  contractEntries,
  chainTokenSymbols,
  chainAddressLabels,
} from "../src/tokens";
import knownPools from "./fixtures/known-pools.json" with { type: "json" };

const USDM_CELO = "0x765de816845861e75a25fca122bb6898b8b1282a";
const GBPM_CELO = "0xccf663b1ff11028f0b19058d0f7b674004a40746";
const USDC_CELO = "0xceba9300f2b948710d2653dd7b07f33a8b32118c";
const USDMSPOKE_MONAD = "0xbc69212b8e4d445b2307c9d32dd68e2a4df00115";
const EURMSPOKE_MONAD = "0x4d502d735b4c574b487ed641ae87ceae884731c7";
const AUSD_MONAD = "0x00000000efe302beaa2b3e6e1b18d08d69a9012a";

describe("tokenSymbol", () => {
  it("resolves Celo mainnet token addresses", () => {
    expect(tokenSymbol(42220, USDM_CELO)).toBe("USDm");
    expect(tokenSymbol(42220, GBPM_CELO)).toBe("GBPm");
    expect(tokenSymbol(42220, USDC_CELO)).toBe("USDC");
  });

  it("strips the trailing Spoke suffix on Monad token names", () => {
    expect(tokenSymbol(143, USDMSPOKE_MONAD)).toBe("USDm");
    expect(tokenSymbol(143, EURMSPOKE_MONAD)).toBe("EURm");
    expect(tokenSymbol(143, AUSD_MONAD)).toBe("AUSD");
  });

  it("is case-insensitive on the address", () => {
    expect(tokenSymbol(42220, USDM_CELO.toUpperCase())).toBe("USDm");
  });

  it("returns null for unknown addresses", () => {
    expect(tokenSymbol(42220, "0xdeadbeef")).toBeNull();
  });

  it("returns null for unknown chains", () => {
    expect(tokenSymbol(99999, USDM_CELO)).toBeNull();
  });

  it("returns null for null/empty address", () => {
    expect(tokenSymbol(42220, null)).toBeNull();
    expect(tokenSymbol(42220, "")).toBeNull();
  });
});

describe("poolName", () => {
  it.each(knownPools)(
    "derives $expectedLabel for $poolId",
    ({ chainId, token0, token1, expectedLabel }) => {
      expect(poolName(chainId, token0, token1)).toBe(expectedLabel);
    },
  );

  it("puts USDm last regardless of token0/token1 ordering", () => {
    expect(poolName(42220, USDM_CELO, GBPM_CELO)).toBe("GBPm/USDm");
    expect(poolName(42220, GBPM_CELO, USDM_CELO)).toBe("GBPm/USDm");
  });

  it("returns null when either leg is unresolved", () => {
    expect(poolName(42220, "0xdeadbeef", USDM_CELO)).toBeNull();
    expect(poolName(42220, USDM_CELO, "0xdeadbeef")).toBeNull();
    expect(poolName(42220, null, null)).toBeNull();
  });

  it("returns null when exactly one leg is null (PoolRow nullable columns)", () => {
    expect(poolName(42220, null, USDM_CELO)).toBeNull();
    expect(poolName(42220, USDM_CELO, null)).toBeNull();
  });

  it("renders USDm/USDm when both legs resolve to USDm (defensive; no real pool does this today)", () => {
    expect(poolName(42220, USDM_CELO, USDM_CELO)).toBe("USDm/USDm");
  });
});

describe("contractEntries", () => {
  it("emits every entry from contracts.json for a chain, including non-tokens", () => {
    const entries = contractEntries(42220);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.canonicalName === "USDm")).toBe(true);
    expect(entries.some((e) => e.rawName.startsWith("StableToken"))).toBe(true);
  });

  it("canonicalizes trailing Spoke on token entries only", () => {
    const monadEntries = contractEntries(143);
    const usdm = monadEntries.find(
      (e) => e.address === USDMSPOKE_MONAD && e.type === "token",
    );
    expect(usdm?.rawName).toBe("USDmSpoke");
    expect(usdm?.canonicalName).toBe("USDm");
  });

  it("returns all entries across chains when chainId is omitted", () => {
    const all = contractEntries();
    expect(all.some((e) => e.chainId === 42220)).toBe(true);
    expect(all.some((e) => e.chainId === 143)).toBe(true);
  });

  it("returns empty array for unknown chains", () => {
    expect(contractEntries(99999)).toEqual([]);
  });
});

describe("chainTokenSymbols", () => {
  it("returns address (lower) → symbol map excluding StableToken* entries", () => {
    const symbols = chainTokenSymbols(42220);
    expect(symbols[USDM_CELO]).toBe("USDm");
    expect(symbols[GBPM_CELO]).toBe("GBPm");
    // StableToken* is an implementation contract — not a user-facing token.
    for (const name of Object.values(symbols)) {
      expect(name.startsWith("StableToken")).toBe(false);
    }
  });

  it("retains Mock* entries (Sepolia MockERC20* are real pool tokens there)", () => {
    const sepolia = chainTokenSymbols(11142220);
    const mocks = Object.values(sepolia).filter((n) => n.startsWith("Mock"));
    expect(mocks.length).toBeGreaterThan(0);
  });

  it("excludes non-token entries (type != 'token')", () => {
    const symbols = chainTokenSymbols(42220);
    const allEntries = contractEntries(42220);
    const nonTokenAddresses = allEntries
      .filter((e) => e.type !== "token")
      .map((e) => e.address);
    for (const addr of nonTokenAddresses) {
      expect(symbols[addr]).toBeUndefined();
    }
  });

  it("returns empty map for unknown chains", () => {
    expect(chainTokenSymbols(99999)).toEqual({});
  });
});

describe("chainAddressLabels", () => {
  it("includes implementation contracts with raw names", () => {
    const labels = chainAddressLabels(42220);
    expect(Object.keys(labels).length).toBeGreaterThan(0);
    // StableToken* addresses ARE in addressLabels (address-book precision)
    // even though they're excluded from tokenSymbols.
    const hasStableToken = Object.values(labels).some((v) =>
      v.startsWith("StableToken"),
    );
    expect(hasStableToken).toBe(true);
  });

  it("canonicalizes token names (trailing Spoke stripped) in Monad", () => {
    const labels = chainAddressLabels(143);
    expect(labels[USDMSPOKE_MONAD]).toBe("USDm");
  });
});
