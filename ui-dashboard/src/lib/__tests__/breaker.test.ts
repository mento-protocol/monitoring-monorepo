import { describe, expect, it } from "vitest";

import { effectiveBreakerThreshold, pickTrippableConfig } from "@/lib/breaker";
import type { BreakerConfig } from "@/lib/types";

// Minimal `BreakerConfig` factory — only the fields the helpers read. Avoids
// dragging unrelated schema churn (e.g. an added trip-counter field) into
// every test. Casts via `unknown` because the live type has many more fields.
function makeConfig(
  overrides: {
    id?: string;
    enabled?: boolean;
    kind?: "MEDIAN_DELTA" | "VALUE_DELTA" | "MARKET_HOURS";
    rateChangeThreshold?: string;
    defaultRateChangeThreshold?: string;
  } = {},
): BreakerConfig {
  const {
    id = "1",
    enabled = true,
    kind = "MEDIAN_DELTA",
    rateChangeThreshold = "0",
    defaultRateChangeThreshold = "40000000000000000000000", // 4%
  } = overrides;
  return {
    id,
    enabled,
    rateChangeThreshold,
    breaker: { kind, defaultRateChangeThreshold },
  } as unknown as BreakerConfig;
}

describe("pickTrippableConfig", () => {
  it("returns the enabled non-MARKET_HOURS config", () => {
    const median = makeConfig({ id: "1", kind: "MEDIAN_DELTA" });
    const marketHours = makeConfig({ id: "2", kind: "MARKET_HOURS" });
    expect(pickTrippableConfig([marketHours, median])).toBe(median);
  });

  it("returns null when only a MARKET_HOURS config exists", () => {
    // MARKET_HOURS is a schedule halt, not a deviation comparator — both
    // <BreakerPanel /> and the oracle chart filter it out.
    const marketHours = makeConfig({ kind: "MARKET_HOURS" });
    expect(pickTrippableConfig([marketHours])).toBeNull();
  });

  it("returns null when the only trip-able config is disabled", () => {
    // A disabled breaker would not be evaluated by the contract — the chart
    // must not draw a band for it and the panel must not render a stale
    // strip. The removed chart-specific query filtered `enabled: true` at the
    // GraphQL layer; this lock prevents reintroducing a fallback that would
    // surface a disabled breaker as live.
    const disabled = makeConfig({ enabled: false });
    expect(pickTrippableConfig([disabled])).toBeNull();
  });

  it("prefers the enabled config when a disabled trip-able row also exists", () => {
    const disabled = makeConfig({ id: "1", enabled: false });
    const enabled = makeConfig({ id: "2", enabled: true });
    expect(pickTrippableConfig([disabled, enabled])).toBe(enabled);
  });

  it("returns null on an empty input", () => {
    expect(pickTrippableConfig([])).toBeNull();
  });
});

describe("effectiveBreakerThreshold", () => {
  it("returns the per-feed override when it is non-zero", () => {
    const cfg = makeConfig({
      rateChangeThreshold: "50000000000000000000000", // 5%
      defaultRateChangeThreshold: "40000000000000000000000", // 4%
    });
    expect(effectiveBreakerThreshold(cfg)).toBe(
      BigInt("50000000000000000000000"),
    );
  });

  it("inherits the breaker default when the per-feed override is the sentinel '0'", () => {
    // The on-chain BreakerBox treats `rateChangeThreshold == 0` as "inherit
    // from the Breaker default". Dropping this branch would collapse the
    // chart band to zero and the panel threshold readout to "0%".
    const cfg = makeConfig({
      rateChangeThreshold: "0",
      defaultRateChangeThreshold: "40000000000000000000000",
    });
    expect(effectiveBreakerThreshold(cfg)).toBe(
      BigInt("40000000000000000000000"),
    );
  });
});
