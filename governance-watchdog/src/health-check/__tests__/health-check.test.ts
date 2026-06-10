import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, type QuicknodeEvent } from "../../events/types.js";

const SORTED_ORACLES_ADDRESS = "0xefb84935239dacdecf7c5ba76d8de40b077b7b33";
const CELO_CUSD_RATE_FEED_ADDRESS =
  "0x765DE816845861e75A25fCA122bb6898B8B1282a";

/** Build a typed MedianUpdated event emitted by a given contract address */
const makeMedianUpdated = (
  address: string,
  token: string = CELO_CUSD_RATE_FEED_ADDRESS,
): QuicknodeEvent => ({
  address,
  blockHash: "0xdeadbeef",
  blockNumber: "47256479",
  logIndex: "0xf9",
  name: EventType.MedianUpdated,
  token: token as `0x${string}`,
  transactionHash: "0xabc",
  value: BigInt("251823330000000000000000"),
});

describe("handleHealthCheckEvent", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs [HealthCheck] for a cUSD MedianUpdated event from SortedOracles", async () => {
    const { default: handleHealthCheckEvent } = await import("../index.js");

    handleHealthCheckEvent(makeMedianUpdated(SORTED_ORACLES_ADDRESS));

    expect(console.info).toHaveBeenCalledWith(
      "[HealthCheck]: Block",
      "47256479",
    );
  });

  it("ignores MedianUpdated events emitted by other contracts", async () => {
    const { default: handleHealthCheckEvent } = await import("../index.js");

    handleHealthCheckEvent(
      makeMedianUpdated("0x1234567890123456789012345678901234567890"),
    );

    expect(console.info).not.toHaveBeenCalled();
  });

  it("ignores MedianUpdated events from SortedOracles for other rate feeds", async () => {
    const { default: handleHealthCheckEvent } = await import("../index.js");

    handleHealthCheckEvent(
      makeMedianUpdated(
        SORTED_ORACLES_ADDRESS,
        "0x0000000000000000000000000000000000000001",
      ),
    );

    expect(console.info).not.toHaveBeenCalled();
  });
});
