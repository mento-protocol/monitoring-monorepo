import { describe, expect, it } from "vitest";
import thresholdData from "../bridge-thresholds.json";
import {
  BRIDGE_STUCK_THRESHOLD_SECONDS,
  bridgeProgressionTimestamp,
  bridgeStateAgeSeconds,
  deriveBridgeStatus,
  isBridgeInFlight,
  type BridgeProgression,
} from "../src/bridge-status";

describe("shared bridge progression", () => {
  it("exports the machine-readable rule thresholds", () => {
    expect(BRIDGE_STUCK_THRESHOLD_SECONDS).toEqual(thresholdData);
    expect(thresholdData).toEqual({
      PENDING: 3600,
      SENT: 3600,
      ATTESTED: 900,
      QUEUED_INBOUND: 86400,
    });
  });
  for (const [status, threshold] of Object.entries(thresholdData)) {
    it(`${status} uses a strict threshold`, () => {
      const row = { status, firstSeenAt: "100" } as BridgeProgression;
      expect(deriveBridgeStatus(row, 100 + threshold)).toBe(status);
      expect(deriveBridgeStatus(row, 101 + threshold)).toBe("STUCK");
      expect(isBridgeInFlight(status)).toBe(true);
    });
  }
  for (const status of ["DELIVERED", "CANCELLED", "FAILED"] as const) {
    it(`excludes terminal ${status}`, () => {
      expect(deriveBridgeStatus({ status, firstSeenAt: "1" }, 1_000_000)).toBe(
        status,
      );
      expect(isBridgeInFlight(status)).toBe(false);
    });
  }
  it("uses destination-first time and attestation before a late source upsert", () => {
    expect(
      bridgeProgressionTimestamp({ status: "PENDING", firstSeenAt: "100" }),
    ).toBe(100);
    expect(
      bridgeProgressionTimestamp({
        status: "ATTESTED",
        lastAttestedTimestamp: "400",
        lastUpdatedAt: "100",
        sentTimestamp: "200",
        firstSeenAt: "300",
      }),
    ).toBe(400);
    expect(
      bridgeProgressionTimestamp({
        status: "SENT",
        lastAttestedTimestamp: "400",
        lastUpdatedAt: "100",
        sentTimestamp: "200",
        firstSeenAt: "300",
      }),
    ).toBe(100);
  });
  for (const invalid of [
    undefined,
    null,
    "",
    "0",
    "NaN",
    "Infinity",
    "no-time",
  ]) {
    it(`falls through unknown timestamp ${String(invalid)}`, () => {
      const row: BridgeProgression = {
        status: "ATTESTED",
        lastAttestedTimestamp: invalid,
        lastUpdatedAt: invalid,
        sentTimestamp: invalid,
        firstSeenAt: "100",
      };
      expect(bridgeProgressionTimestamp(row)).toBe(100);
      expect(
        bridgeStateAgeSeconds({ ...row, firstSeenAt: invalid }, 1000),
      ).toBeNull();
      expect(deriveBridgeStatus({ ...row, firstSeenAt: invalid }, 1000)).toBe(
        "ATTESTED",
      );
    });
  }
  it("preserves negative epochs and future timestamps", () => {
    expect(
      bridgeStateAgeSeconds({ status: "SENT", firstSeenAt: "-1" }, 3600),
    ).toBe(3601);
    expect(
      deriveBridgeStatus({ status: "SENT", firstSeenAt: "-1" }, 3600),
    ).toBe("STUCK");
    expect(
      bridgeStateAgeSeconds({ status: "SENT", firstSeenAt: "200" }, 100),
    ).toBe(-100);
    expect(
      deriveBridgeStatus({ status: "SENT", firstSeenAt: "200" }, 100),
    ).toBe("SENT");
  });
});
