import { describe, expect, it } from "vitest";
import oracleReportersJson from "../oracle-reporters.json" with { type: "json" };
import {
  describeRateFeed,
  getChainlinkDataFeedUrl,
  getOracleReporterType,
  getRateFeedChainlinkDataFeedUrl,
  getRateFeedPair,
  knownRateFeedsByChain,
} from "../src/oracle-reporters";

type RawChainEntry = {
  feeds: Record<string, { pair: string }>;
  reporters?: Record<string, { type?: string }>;
};

const ROOT = oracleReportersJson as Record<string, RawChainEntry>;

describe("oracle reporter registry", () => {
  it("looks up feed pairs by chain-scoped feed address", () => {
    expect(
      getRateFeedPair(143, "0x81A313Ff894BFC6093d33b5514e34d7Faa41B7eF"),
    ).toBe("USDC/USD");
    expect(
      getRateFeedPair(42220, "0xf590b62f9cfcc6409075b1ecac8176fe25744b88"),
    ).toBe("GBP/USD");
  });

  it("maps known reporters to static adapter types and unknown reporters to manual", () => {
    expect(
      getOracleReporterType(143, "0xDb8fc8c6DaaC8F73E21e9cC145440AB899d60e55"),
    ).toBe("CHAINLINK");
    expect(
      getOracleReporterType(143, "0x0000000000000000000000000000000000000000"),
    ).toBe("MANUAL");
  });

  it("keeps reporterTypes aligned with reporters", () => {
    expect(
      describeRateFeed(143, "0xea4103a6a122fbe2cdb07a80d4d293be07bb29fa", [
        "0xdb8fc8c6daac8f73e21e9cc145440ab899d60e55",
        "0x0000000000000000000000000000000000000000",
      ]),
    ).toEqual({
      pair: "GBP/USD",
      reporterTypes: ["CHAINLINK", "MANUAL"],
    });
  });

  it("builds chain-aware Chainlink data feed URLs", () => {
    expect(getChainlinkDataFeedUrl(42220, "GBP/USD")).toBe(
      "https://data.chain.link/feeds/celo/mainnet/gbp-usd",
    );
    expect(getChainlinkDataFeedUrl(143, "GBP/USD")).toBe(
      "https://data.chain.link/feeds/monad/monad/gbp-usd",
    );
    expect(
      getRateFeedChainlinkDataFeedUrl(
        143,
        "0xea4103a6a122fbe2cdb07a80d4d293be07bb29fa",
      ),
    ).toBe("https://data.chain.link/feeds/monad/monad/gbp-usd");
  });

  it("returns stable defaults for unknown feeds and chains", () => {
    const unknownFeed = "0x0000000000000000000000000000000000000000";

    expect(getRateFeedPair(42220, unknownFeed)).toBeNull();
    expect(getRateFeedPair(999_999, unknownFeed)).toBeNull();
    expect(getChainlinkDataFeedUrl(999_999, "GBP/USD")).toBeNull();
    expect(getRateFeedChainlinkDataFeedUrl(42220, unknownFeed)).toBeNull();
    expect(knownRateFeedsByChain(999_999).size).toBe(0);
    expect(describeRateFeed(999_999, unknownFeed, [])).toEqual({
      pair: "Unknown",
      reporterTypes: [],
    });
  });

  it("enumerates every feed entry for a chain", () => {
    const feeds = knownRateFeedsByChain(42220);
    const jsonFeeds = ROOT["42220"];
    expect(jsonFeeds && typeof jsonFeeds === "object").toBe(true);
    expect(feeds.size).toBe(
      Object.keys((jsonFeeds as RawChainEntry).feeds ?? {}).length,
    );
  });

  it("stores lowercase addresses in every chain block", () => {
    for (const [chainId, value] of Object.entries(ROOT)) {
      for (const address of Object.keys(value.feeds ?? {})) {
        expect(address, `${chainId} feed ${address}`).toBe(
          address.toLowerCase(),
        );
      }
      for (const address of Object.keys(value.reporters ?? {})) {
        expect(address, `${chainId} reporter ${address}`).toBe(
          address.toLowerCase(),
        );
      }
    }
  });
});
