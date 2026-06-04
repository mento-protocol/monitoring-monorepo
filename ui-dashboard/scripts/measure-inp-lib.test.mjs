import { describe, expect, it } from "vitest";
import {
  classifyTerminalState,
  DEFAULT_READY_TIMEOUT_MS,
  matchesEmptyVolumeMarker,
  resolveReadyTimeout,
  unavailableTerminalState,
  VOLUME_READY_TIMEOUT_MS,
} from "./measure-inp-lib.mjs";

describe("resolveReadyTimeout", () => {
  it("uses the default when a surface sets no readyTimeout", () => {
    expect(resolveReadyTimeout({ name: "pools-filter" })).toBe(
      DEFAULT_READY_TIMEOUT_MS,
    );
  });

  it("uses the surface's explicit readyTimeout (the /volume override)", () => {
    expect(
      resolveReadyTimeout({
        name: "volume-sort",
        readyTimeout: VOLUME_READY_TIMEOUT_MS,
      }),
    ).toBe(VOLUME_READY_TIMEOUT_MS);
  });

  it("keeps the two timeouts distinct and ordered", () => {
    expect(VOLUME_READY_TIMEOUT_MS).toBeGreaterThan(DEFAULT_READY_TIMEOUT_MS);
  });
});

describe("classifyTerminalState", () => {
  it("reports a backend error first — role=alert wins over other markers", () => {
    expect(
      classifyTerminalState({ loading: true, error: true, empty: true }),
    ).toMatch(/backend erroring/);
  });

  it("reports still-loading when only the skeleton is up", () => {
    expect(
      classifyTerminalState({ loading: true, error: false, empty: false }),
    ).toMatch(/still loading/);
  });

  it("reports empty when the window legitimately has no rows", () => {
    expect(
      classifyTerminalState({ loading: false, error: false, empty: true }),
    ).toMatch(/no data/);
  });

  it("reports unknown when no marker is present", () => {
    expect(
      classifyTerminalState({ loading: false, error: false, empty: false }),
    ).toMatch(/unknown/);
  });
});

describe("matchesEmptyVolumeMarker", () => {
  it.each([
    "No traders matched this window. Try widening the range or including protocol actors.",
    "No traders left after exploratory exclusions. Clear exclusions or widen the range.",
    "No v3 aggregator activity in this window.",
    "No v2 aggregator volume in this window.",
  ])("matches the /volume empty-state copy: %s", (text) => {
    expect(matchesEmptyVolumeMarker(text)).toBe(true);
  });

  it("does not match a populated table", () => {
    expect(
      matchesEmptyVolumeMarker("Top traders (7d)  Volume  Swaps  Pools"),
    ).toBe(false);
  });
});

describe("unavailableTerminalState", () => {
  it("preserves the underlying page.evaluate failure reason", () => {
    const cause = unavailableTerminalState(
      "Target page, context or browser has been closed",
    );
    expect(cause).toMatch(/page closed\/crashed/);
    expect(cause).toContain("Target page, context or browser has been closed");
  });
});
