import { describe, it, expect } from "vitest";
import {
  ALL_BRIDGE_STATUSES,
  deriveBridgeStatus,
  formatDurationShort,
  bridgeStatusLabel,
  bridgeStatusDetailLabel,
  parseDurationSeconds,
  transferDeliveryDurationSec,
} from "../bridge-status";

describe("deriveBridgeStatus", () => {
  it("passes through terminal statuses unchanged", () => {
    expect(
      deriveBridgeStatus(
        { status: "DELIVERED", sentTimestamp: "100", firstSeenAt: "100" },
        99999,
      ),
    ).toBe("DELIVERED");
    expect(
      deriveBridgeStatus(
        { status: "CANCELLED", sentTimestamp: null, firstSeenAt: "0" },
        99999,
      ),
    ).toBe("CANCELLED");
    expect(
      deriveBridgeStatus(
        { status: "FAILED", sentTimestamp: null, firstSeenAt: "0" },
        99999,
      ),
    ).toBe("FAILED");
  });

  it("keeps QUEUED_INBOUND within the 24h window", () => {
    const now = 1_700_100_000;
    const sentRecently = now - 2 * 60 * 60;
    expect(
      deriveBridgeStatus(
        {
          status: "QUEUED_INBOUND",
          sentTimestamp: String(sentRecently),
          firstSeenAt: String(sentRecently),
        },
        now,
      ),
    ).toBe("QUEUED_INBOUND");
  });

  it("overlays STUCK for QUEUED_INBOUND transfers past the threshold", () => {
    const now = 1_700_100_000;
    const sentLongAgo = now - 48 * 60 * 60;
    expect(
      deriveBridgeStatus(
        {
          status: "QUEUED_INBOUND",
          sentTimestamp: String(sentLongAgo),
          firstSeenAt: String(sentLongAgo),
        },
        now,
      ),
    ).toBe("STUCK");
  });

  it("keeps SENT within the 24h window", () => {
    const now = 1_700_100_000;
    const sentRecently = now - 23 * 60 * 60;
    expect(
      deriveBridgeStatus(
        {
          status: "SENT",
          sentTimestamp: String(sentRecently),
          firstSeenAt: String(sentRecently),
        },
        now,
      ),
    ).toBe("SENT");
  });

  it("overlays STUCK when SENT passes the 24h threshold", () => {
    const now = 1_700_100_000;
    const sentLongAgo = now - 25 * 60 * 60;
    expect(
      deriveBridgeStatus(
        {
          status: "SENT",
          sentTimestamp: String(sentLongAgo),
          firstSeenAt: String(sentLongAgo),
        },
        now,
      ),
    ).toBe("STUCK");
  });

  it("overlays STUCK for ATTESTED transfers past the threshold", () => {
    const now = 1_700_100_000;
    const sentLongAgo = now - 25 * 60 * 60;
    expect(
      deriveBridgeStatus(
        {
          status: "ATTESTED",
          sentTimestamp: String(sentLongAgo),
          firstSeenAt: String(sentLongAgo),
        },
        now,
      ),
    ).toBe("STUCK");
  });

  it("ages SENT via firstSeenAt when sentTimestamp is missing (dest-first race)", () => {
    // Prior behaviour left this as SENT forever; now firstSeenAt is the
    // fallback clock so the stuck-transfer view surfaces it.
    const now = 1_700_100_000;
    const firstSeenLongAgo = now - 30 * 60 * 60;
    expect(
      deriveBridgeStatus(
        {
          status: "SENT",
          sentTimestamp: null,
          firstSeenAt: String(firstSeenLongAgo),
        },
        now,
      ),
    ).toBe("STUCK");
  });

  it("ages PENDING via firstSeenAt past threshold", () => {
    const now = 1_700_100_000;
    const firstSeenLongAgo = now - 30 * 60 * 60;
    expect(
      deriveBridgeStatus(
        {
          status: "PENDING",
          sentTimestamp: null,
          firstSeenAt: String(firstSeenLongAgo),
        },
        now,
      ),
    ).toBe("STUCK");
  });

  it("keeps PENDING within the 24h window from firstSeenAt", () => {
    const now = 1_700_100_000;
    const firstSeenRecently = now - 2 * 60 * 60;
    expect(
      deriveBridgeStatus(
        {
          status: "PENDING",
          sentTimestamp: null,
          firstSeenAt: String(firstSeenRecently),
        },
        now,
      ),
    ).toBe("PENDING");
  });

  it("returns the raw status when both timestamps are missing/invalid", () => {
    expect(
      deriveBridgeStatus(
        { status: "SENT", sentTimestamp: null, firstSeenAt: "not-a-number" },
        99999,
      ),
    ).toBe("SENT");
  });
});

describe("formatDurationShort", () => {
  it("sub-minute", () => {
    expect(formatDurationShort(0)).toBe("0s");
    expect(formatDurationShort(1)).toBe("1s");
    expect(formatDurationShort(45.4)).toBe("45s");
  });

  it("rounds to whole seconds before bucketing (no '60s' / '1m 60s' artifacts)", () => {
    // 59.6s used to render as '60s' under the old floor+round split.
    expect(formatDurationShort(59.6)).toBe("1m");
    // 119.5s used to render as '1m 60s' under the old split.
    expect(formatDurationShort(119.5)).toBe("2m");
    // 3599.5s used to render as '59m 60s'.
    expect(formatDurationShort(3599.5)).toBe("1h 0m");
  });

  it("drops the seconds segment when it's zero", () => {
    expect(formatDurationShort(120)).toBe("2m");
    expect(formatDurationShort(3600)).toBe("1h 0m");
  });

  it("renders minutes and seconds when s > 0", () => {
    expect(formatDurationShort(95)).toBe("1m 35s");
  });

  it("renders days + hours once >= 1 day", () => {
    expect(formatDurationShort(86_400)).toBe("1d 0h");
    expect(formatDurationShort(3 * 86_400 + 4 * 3600)).toBe("3d 4h");
  });

  it("renders the final second-below-a-day as hours+minutes (86_399 → 23h 59m)", () => {
    // Boundary: one second under a full day stays in the h/m bucket; the
    // day bucket only kicks in at >= 86_400s. This guards against a stray
    // Math.ceil/floor swap in the bucketing code.
    expect(formatDurationShort(86_399)).toBe("23h 59m");
  });
});

describe("parseDurationSeconds", () => {
  it("parses single-unit short forms", () => {
    expect(parseDurationSeconds("30s")).toBe(30);
    expect(parseDurationSeconds("10m")).toBe(600);
    expect(parseDurationSeconds("1h")).toBe(3600);
    expect(parseDurationSeconds("3d")).toBe(259_200);
    expect(parseDurationSeconds("2w")).toBe(1_209_600);
  });

  it("parses full-word units with arbitrary spacing and case", () => {
    expect(parseDurationSeconds("3 days")).toBe(259_200);
    expect(parseDurationSeconds("2 HOURS")).toBe(7200);
    expect(parseDurationSeconds("1 week")).toBe(604_800);
    expect(parseDurationSeconds("  30 mins  ")).toBe(1800);
  });

  it("composes multi-unit strings", () => {
    expect(parseDurationSeconds("1h30m")).toBe(5400);
    expect(parseDurationSeconds("1d 6h")).toBe(108_000);
    expect(parseDurationSeconds("2h15m30s")).toBe(8130);
  });

  it("treats bare integers as seconds", () => {
    expect(parseDurationSeconds("60")).toBe(60);
    expect(parseDurationSeconds("3600")).toBe(3600);
  });

  it("returns null for empty or unparsable input", () => {
    expect(parseDurationSeconds("")).toBeNull();
    expect(parseDurationSeconds("   ")).toBeNull();
    expect(parseDurationSeconds("banana")).toBeNull();
    expect(parseDurationSeconds("1 month")).toBeNull(); // intentionally unsupported
    expect(parseDurationSeconds("1h banana")).toBeNull(); // trailing junk
    expect(parseDurationSeconds("1h 2x")).toBeNull();
  });
});

describe("transferDeliveryDurationSec", () => {
  it("returns null when sentTimestamp is missing", () => {
    expect(
      transferDeliveryDurationSec({
        sentTimestamp: null,
        deliveredTimestamp: "100",
      }),
    ).toBeNull();
  });

  it("returns null when deliveredTimestamp is missing", () => {
    expect(
      transferDeliveryDurationSec({
        sentTimestamp: "100",
        deliveredTimestamp: null,
      }),
    ).toBeNull();
  });

  it("returns the delta in seconds when both sides are present", () => {
    expect(
      transferDeliveryDurationSec({
        sentTimestamp: "1000",
        deliveredTimestamp: "1125",
      }),
    ).toBe(125);
  });

  it("clamps a negative delta (clock skew) to 0 instead of surfacing it", () => {
    expect(
      transferDeliveryDurationSec({
        sentTimestamp: "1000",
        deliveredTimestamp: "999",
      }),
    ).toBe(0);
  });

  it("treats '0' (epoch) as missing so pre-indexed/race rows return null", () => {
    // An indexer writing a "0" string to sentTimestamp (before the real
    // source event is seen) shouldn't produce a delivered-from-epoch delta
    // on the order of 5+ decades — treat the epoch sentinel as missing.
    expect(
      transferDeliveryDurationSec({
        sentTimestamp: "0",
        deliveredTimestamp: "1000",
      }),
    ).toBeNull();
  });

  it("returns null when a timestamp isn't a finite number (NaN guard)", () => {
    expect(
      transferDeliveryDurationSec({
        sentTimestamp: "abc",
        deliveredTimestamp: "1000",
      }),
    ).toBeNull();
  });
});

describe("bridgeStatusLabel", () => {
  it("collapses the three in-flight sub-states to 'In progress' — Wormholescan parity", () => {
    // SENT / ATTESTED / QUEUED_INBOUND are indexer-internal distinctions;
    // Wormholescan shows one "IN PROGRESS" label for the whole transit
    // phase. The table cell follows the Wormhole labelling so users don't
    // have to reconcile two vocabularies for the same lifecycle stage.
    expect(bridgeStatusLabel("SENT")).toBe("In progress");
    expect(bridgeStatusLabel("ATTESTED")).toBe("In progress");
    expect(bridgeStatusLabel("QUEUED_INBOUND")).toBe("In progress");
  });

  it("has a label for every terminal / overlay status", () => {
    expect(bridgeStatusLabel("DELIVERED")).toBe("Delivered");
    expect(bridgeStatusLabel("STUCK")).toBe("Stuck");
    expect(bridgeStatusLabel("PENDING")).toBe("Pending");
    expect(bridgeStatusLabel("CANCELLED")).toBe("Cancelled");
    expect(bridgeStatusLabel("FAILED")).toBe("Failed");
  });
});

describe("bridgeStatusDetailLabel", () => {
  it("keeps granular labels for the filter pills", () => {
    // The filter UI needs to distinguish the in-flight sub-states (so the
    // user can scope to just SENT, or just QUEUED_INBOUND) — collapsing
    // them would leave three "In progress" pills with no way to tell them
    // apart.
    expect(bridgeStatusDetailLabel("SENT")).toBe("Sent");
    expect(bridgeStatusDetailLabel("ATTESTED")).toBe("Attested");
    expect(bridgeStatusDetailLabel("QUEUED_INBOUND")).toBe("Queued");
  });

  it("has a distinct detail label for every terminal / overlay status", () => {
    // Covers the statuses that aren't in the filter pill list but still
    // round-trip through the function (table badges, blame tooltips, etc.).
    expect(bridgeStatusDetailLabel("PENDING")).toBe("Pending");
    expect(bridgeStatusDetailLabel("DELIVERED")).toBe("Delivered");
    expect(bridgeStatusDetailLabel("CANCELLED")).toBe("Cancelled");
    expect(bridgeStatusDetailLabel("FAILED")).toBe("Failed");
    expect(bridgeStatusDetailLabel("STUCK")).toBe("Stuck");
  });
});

describe("ALL_BRIDGE_STATUSES", () => {
  it("matches the indexer-supported subset exactly", () => {
    // Hard-coded literal — the *whole point* is to force a conscious
    // update when the indexer starts writing a new status. If this test
    // fails, decide whether the filter UI should expose the new status
    // (add it here + to BridgeStatusBadge coverage) or keep hiding it.
    //
    // CANCELLED and FAILED are schema-reserved but unwritten in v1 —
    // see indexer-envio/src/wormhole/status.ts. Exposing them in the
    // filter would let the user narrow to an always-empty set.
    expect([...ALL_BRIDGE_STATUSES]).toEqual([
      "PENDING",
      "SENT",
      "ATTESTED",
      "QUEUED_INBOUND",
      "DELIVERED",
    ]);
  });
});
