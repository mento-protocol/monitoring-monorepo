import { describe, it, expect } from "vitest";
import {
  deriveBridgeStatus,
  computeAvgDeliverTime,
  formatDurationShort,
  bridgeStatusLabel,
} from "../bridge-status";
import type { BridgeTransfer } from "../types";

function mkTransfer(overrides: Partial<BridgeTransfer>): BridgeTransfer {
  return {
    id: "wormhole-0xabc",
    provider: "WORMHOLE",
    providerMessageId: "0xabc",
    status: "PENDING",
    tokenSymbol: "USDm",
    tokenAddress: "0x0",
    tokenDecimals: 18,
    sourceChainId: null,
    sourceContract: null,
    destChainId: null,
    destContract: null,
    sender: null,
    recipient: null,
    amount: null,
    sentBlock: null,
    sentTimestamp: null,
    sentTxHash: null,
    attestationCount: 0,
    firstAttestedTimestamp: null,
    lastAttestedTimestamp: null,
    deliveredBlock: null,
    deliveredTimestamp: null,
    deliveredTxHash: null,
    cancelledTimestamp: null,
    failedReason: null,
    usdPriceAtSend: null,
    usdValueAtSend: null,
    firstSeenAt: "0",
    lastUpdatedAt: "0",
    ...overrides,
  };
}

describe("deriveBridgeStatus", () => {
  it("passes through terminal statuses unchanged", () => {
    expect(
      deriveBridgeStatus({ status: "DELIVERED", sentTimestamp: "100" }, 99999),
    ).toBe("DELIVERED");
    expect(
      deriveBridgeStatus({ status: "CANCELLED", sentTimestamp: null }, 99999),
    ).toBe("CANCELLED");
    expect(
      deriveBridgeStatus({ status: "FAILED", sentTimestamp: null }, 99999),
    ).toBe("FAILED");
    expect(
      deriveBridgeStatus(
        { status: "QUEUED_INBOUND", sentTimestamp: "100" },
        99999,
      ),
    ).toBe("QUEUED_INBOUND");
  });

  it("keeps SENT within the 24h window", () => {
    const now = 1_700_100_000;
    const sentRecently = now - 23 * 60 * 60; // 23h ago — still SENT
    expect(
      deriveBridgeStatus(
        { status: "SENT", sentTimestamp: String(sentRecently) },
        now,
      ),
    ).toBe("SENT");
  });

  it("overlays STUCK when SENT passes the 24h threshold", () => {
    const now = 1_700_100_000;
    const sentLongAgo = now - 25 * 60 * 60; // 25h ago
    expect(
      deriveBridgeStatus(
        { status: "SENT", sentTimestamp: String(sentLongAgo) },
        now,
      ),
    ).toBe("STUCK");
  });

  it("overlays STUCK for ATTESTED transfers past the threshold", () => {
    const now = 1_700_100_000;
    const sentLongAgo = now - 25 * 60 * 60;
    expect(
      deriveBridgeStatus(
        { status: "ATTESTED", sentTimestamp: String(sentLongAgo) },
        now,
      ),
    ).toBe("STUCK");
  });

  it("does not promote to STUCK when sentTimestamp is null", () => {
    // Dest-first race: status is SENT/ATTESTED but we don't have the source
    // timestamp. Don't speculate about age — show the raw status.
    expect(
      deriveBridgeStatus({ status: "SENT", sentTimestamp: null }, 99999),
    ).toBe("SENT");
  });
});

describe("computeAvgDeliverTime", () => {
  it("returns null with zero sample size when no deliveries exist", () => {
    const r = computeAvgDeliverTime([
      mkTransfer({ status: "SENT" }),
      mkTransfer({ status: "ATTESTED" }),
    ]);
    expect(r.avgSec).toBeNull();
    expect(r.sampleSize).toBe(0);
  });

  it("excludes delivered rows missing sentTimestamp from numerator AND denominator (codex fix)", () => {
    // Dest-first race: row is DELIVERED but source info hasn't been indexed
    // yet. Including it in the denominator under-reports latency.
    const rows = [
      mkTransfer({
        status: "DELIVERED",
        sentTimestamp: "1000",
        deliveredTimestamp: "1100", // 100s delivery
      }),
      mkTransfer({
        status: "DELIVERED",
        sentTimestamp: null, // dest-first: excluded from avg
        deliveredTimestamp: "1500",
      }),
    ];
    const r = computeAvgDeliverTime(rows);
    expect(r.sampleSize).toBe(1);
    expect(r.avgSec).toBe(100);
  });

  it("computes the mean across usable rows", () => {
    const rows = [
      mkTransfer({
        status: "DELIVERED",
        sentTimestamp: "1000",
        deliveredTimestamp: "1100", // 100s
      }),
      mkTransfer({
        status: "DELIVERED",
        sentTimestamp: "2000",
        deliveredTimestamp: "2300", // 300s
      }),
    ];
    const r = computeAvgDeliverTime(rows);
    expect(r.sampleSize).toBe(2);
    expect(r.avgSec).toBe(200);
  });

  it("clamps negative deltas to 0 (out-of-order timestamps)", () => {
    const r = computeAvgDeliverTime([
      mkTransfer({
        status: "DELIVERED",
        sentTimestamp: "2000",
        deliveredTimestamp: "1000", // negative — shouldn't drag the mean
      }),
    ]);
    expect(r.avgSec).toBe(0);
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
});

describe("bridgeStatusLabel", () => {
  it("has a label for every overlay status", () => {
    expect(bridgeStatusLabel("DELIVERED")).toBe("Delivered");
    expect(bridgeStatusLabel("QUEUED_INBOUND")).toBe("Queued");
    expect(bridgeStatusLabel("STUCK")).toBe("Stuck");
    expect(bridgeStatusLabel("PENDING")).toBe("Pending");
  });
});
