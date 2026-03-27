import { describe, it, expect, vi, afterEach } from "vitest";
import {
  truncateAddress,
  parseWei,
  formatWei,
  formatTimestamp,
  relativeTime,
  formatBlock,
  isNamespacedPoolId,
  isValidAddress,
  formatUSD,
  normalizePoolIdForChain,
  TRADING_LIMITS_INTERNAL_DECIMALS,
} from "../format";
// Pool ID utils are tested comprehensively in pool-id.test.ts;
// the imports above verify the re-exports from format.ts still resolve.

// ---------------------------------------------------------------------------
// truncateAddress
// ---------------------------------------------------------------------------
describe("truncateAddress", () => {
  it("returns em-dash for null", () => {
    expect(truncateAddress(null)).toBe("—");
  });

  it("returns address unchanged when <= 10 chars", () => {
    expect(truncateAddress("0x1234567")).toBe("0x1234567");
    expect(truncateAddress("0x12345678")).toBe("0x12345678");
  });

  it("truncates long address to 6+4 format", () => {
    const addr = "0xabc123def456789012345678";
    const result = truncateAddress(addr);
    expect(result).toBe("0xabc1…5678");
  });

  it("truncates standard 42-char Ethereum address", () => {
    const addr = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    const result = truncateAddress(addr);
    expect(result.startsWith("0xd8dA")).toBe(true);
    expect(result.endsWith("6045")).toBe(true);
    expect(result).toContain("…");
  });
});

// ---------------------------------------------------------------------------
// pool ID normalization
// ---------------------------------------------------------------------------
describe("pool ID normalization", () => {
  it("detects namespaced pool IDs", () => {
    expect(
      isNamespacedPoolId("42220-0xd8da6bf26964af9d7eed9e03e53415d37aa96045"),
    ).toBe(true);
    expect(
      isNamespacedPoolId("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
    ).toBe(false);
  });

  it("normalizes raw addresses onto the active chain", () => {
    expect(
      normalizePoolIdForChain(
        "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        42220,
      ),
    ).toBe("42220-0xd8da6bf26964af9d7eed9e03e53415d37aa96045");
  });

  it("preserves already-namespaced pool IDs", () => {
    expect(
      normalizePoolIdForChain(
        "143-0xBC69212B8E4D445B2307C9D32Dd68E2A4Df00115",
        42220,
      ),
    ).toBe("143-0xbc69212b8e4d445b2307c9d32dd68e2a4df00115");
  });
});

// ---------------------------------------------------------------------------
// parseWei
// ---------------------------------------------------------------------------
describe("parseWei", () => {
  it("returns 0 for empty string", () => {
    expect(parseWei("")).toBe(0);
  });

  it('returns 0 for "0"', () => {
    expect(parseWei("0")).toBe(0);
  });

  it("converts 1e18 wei to 1", () => {
    expect(parseWei("1000000000000000000")).toBeCloseTo(1, 6);
  });

  it("supports custom decimals", () => {
    expect(parseWei("1000000", 6)).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------
// formatWei
// ---------------------------------------------------------------------------
describe("formatWei", () => {
  it('returns "0" for "0"', () => {
    expect(formatWei("0")).toBe("0");
  });

  it('returns "0" for empty string', () => {
    expect(formatWei("")).toBe("0");
  });

  it("formats 1 token correctly", () => {
    const result = formatWei("1000000000000000000");
    expect(result).toBe("1.00");
  });

  it("formats 1234.5678 tokens", () => {
    const result = formatWei("1234567800000000000000");
    expect(result).toContain("1,234");
  });

  it("formats very small numbers as fixed decimal (no scientific notation)", () => {
    // 0.00001 token in wei — should show "0.00" not "1.00e-5"
    const result = formatWei("10000000000000"); // 0.00001
    expect(result).toBe("0.00");
  });

  it("formats trading limit values at 15-decimal internal precision", () => {
    // On-chain limit0 for GBPM/USDM: 77000000000000000000 = 77,000 at 15dp
    expect(
      formatWei("77000000000000000000", TRADING_LIMITS_INTERNAL_DECIMALS, 2),
    ).toBe("77,000.00");
  });

  it("formats trading limit netflow at 15-decimal internal precision", () => {
    // On-chain netflow1: 52124244979381018806 ≈ 52,124.24 at 15dp
    expect(
      formatWei("52124244979381018806", TRADING_LIMITS_INTERNAL_DECIMALS, 2),
    ).toBe("52,124.24");
  });
});

// ---------------------------------------------------------------------------
// formatUSD
// ---------------------------------------------------------------------------
describe("formatUSD", () => {
  it("switches to millions at the 999.95K rounding boundary", () => {
    expect(formatUSD(999_950)).toBe("$1.00M");
  });

  it("returns N/A for non-finite values", () => {
    expect(formatUSD(Number.NaN)).toBe("N/A");
    expect(formatUSD(Number.POSITIVE_INFINITY)).toBe("N/A");
  });
});

// ---------------------------------------------------------------------------
// formatBlock
// ---------------------------------------------------------------------------
describe("formatBlock", () => {
  it("formats block number with locale separators", () => {
    const result = formatBlock("1234567");
    expect(result).toContain("1");
    expect(result).toContain("234");
  });

  it('formats "0" as "0"', () => {
    expect(formatBlock("0")).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// formatTimestamp
// ---------------------------------------------------------------------------
describe("formatTimestamp", () => {
  it('returns em-dash for "0"', () => {
    expect(formatTimestamp("0")).toBe("—");
  });

  it("returns em-dash for empty string", () => {
    expect(formatTimestamp("")).toBe("—");
  });

  it("returns a locale date string for a valid unix timestamp", () => {
    // 2024-01-01 00:00:00 UTC
    const result = formatTimestamp("1704067200");
    expect(result).toBeTruthy();
    expect(result).not.toBe("—");
  });
});

// ---------------------------------------------------------------------------
// relativeTime
// ---------------------------------------------------------------------------
describe("relativeTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns em-dash for "0"', () => {
    expect(relativeTime("0")).toBe("—");
  });

  it("returns em-dash for empty string", () => {
    expect(relativeTime("")).toBe("—");
  });

  it("returns seconds ago for recent timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:30Z"));
    const ts = String(new Date("2024-01-01T00:00:00Z").getTime() / 1000);
    expect(relativeTime(ts)).toBe("30s ago");
  });

  it("returns minutes ago for timestamp ~5 minutes old", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:05:00Z"));
    const ts = String(new Date("2024-01-01T00:00:00Z").getTime() / 1000);
    expect(relativeTime(ts)).toBe("5m ago");
  });

  it("returns hours ago for timestamp ~3 hours old", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T03:00:00Z"));
    const ts = String(new Date("2024-01-01T00:00:00Z").getTime() / 1000);
    expect(relativeTime(ts)).toBe("3h ago");
  });

  it("returns days ago for timestamp ~2 days old", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-03T00:00:00Z"));
    const ts = String(new Date("2024-01-01T00:00:00Z").getTime() / 1000);
    expect(relativeTime(ts)).toBe("2d ago");
  });

  it("returns formatted date for future timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    const futureTs = String(new Date("2024-01-02T00:00:00Z").getTime() / 1000);
    // Future timestamps fall through to formatTimestamp
    const result = relativeTime(futureTs);
    expect(result).not.toContain("ago");
    expect(result).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Reserve USD calculation with mixed token decimals
// Mirrors the inline calculation in pool/[poolId]/page.tsx:
//   raw  = parseWei(reserve, tokenDecimals)
//   usd0 = usdmIsToken0 ? raw0 : raw0 * feedVal
//   usd1 = usdmIsToken0 ? raw1 * feedVal : raw1
//   total = usd0 + usd1
// ---------------------------------------------------------------------------
describe("reserve USD calculation (mixed decimals)", () => {
  it("parseWei correctly handles 6-decimal USDm amounts", () => {
    // 1 USDm = 1_000_000 units at 6 decimals
    expect(parseWei("1000000", 6)).toBeCloseTo(1, 6);
  });

  it("parseWei with wrong decimals produces near-zero result (documents the pre-fix bug)", () => {
    // 1_000_000 misread as 18 decimals → 1e-12, not 1
    expect(parseWei("1000000", 18)).toBeCloseTo(1e-12, 18);
  });

  it("computes correct total USD for token0=CELO (18 dec) + token1=USDm (6 dec)", () => {
    // 2 CELO at $0.50 each + 3 USDm at $1 each → $4.00 total
    const raw0 = parseWei("2000000000000000000", 18); // 2 CELO
    const raw1 = parseWei("3000000", 6); // 3 USDm
    const feedVal = 0.5;
    const usdmIsToken0 = false;
    const usd0 = usdmIsToken0 ? raw0 : raw0 * feedVal;
    const usd1 = usdmIsToken0 ? raw1 * feedVal : raw1;
    expect(raw0).toBeCloseTo(2, 6);
    expect(raw1).toBeCloseTo(3, 6);
    expect(usd0).toBeCloseTo(1.0, 6);
    expect(usd1).toBeCloseTo(3.0, 6);
    expect(usd0 + usd1).toBeCloseTo(4.0, 6);
  });

  it("computes correct total USD for token0=USDm (6 dec) + token1=CELO (18 dec)", () => {
    // 2 USDm at $1 each + 4 CELO at $0.50 each → $4.00 total
    const raw0 = parseWei("2000000", 6); // 2 USDm
    const raw1 = parseWei("4000000000000000000", 18); // 4 CELO
    const feedVal = 0.5;
    const usdmIsToken0 = true;
    const usd0 = usdmIsToken0 ? raw0 : raw0 * feedVal;
    const usd1 = usdmIsToken0 ? raw1 * feedVal : raw1;
    expect(raw0).toBeCloseTo(2, 6);
    expect(raw1).toBeCloseTo(4, 6);
    expect(usd0).toBeCloseTo(2.0, 6);
    expect(usd1).toBeCloseTo(2.0, 6);
    expect(usd0 + usd1).toBeCloseTo(4.0, 6);
  });
});

// ---------------------------------------------------------------------------
// isValidAddress
// ---------------------------------------------------------------------------
describe("isValidAddress", () => {
  it("accepts valid lowercase address", () => {
    expect(isValidAddress("0xd8da6bf26964af9d7eed9e03e53415d37aa96045")).toBe(
      true,
    );
  });

  it("accepts valid mixed-case (EIP-55) address", () => {
    expect(isValidAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe(
      true,
    );
  });

  it("rejects address without 0x prefix", () => {
    expect(isValidAddress("d8da6bf26964af9d7eed9e03e53415d37aa96045")).toBe(
      false,
    );
  });

  it("rejects address that is too short", () => {
    expect(isValidAddress("0x1234")).toBe(false);
  });

  it("rejects address with invalid hex characters", () => {
    expect(isValidAddress("0xZZZZZBF26964aF9D7eEd9e03E53415D37aA96045")).toBe(
      false,
    );
  });

  it("rejects empty string", () => {
    expect(isValidAddress("")).toBe(false);
  });
});
