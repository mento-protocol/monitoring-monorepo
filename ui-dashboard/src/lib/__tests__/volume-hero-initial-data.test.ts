import { describe, expect, it } from "vitest";
import {
  protocolActorInForView,
  volumeHeroViewMatches,
  type VolumeHeroView,
} from "../volume-hero-initial-data";

const TODAY_MIDNIGHT = 1_780_000_000 - (1_780_000_000 % 86_400);

const VIEW: VolumeHeroView = {
  networkId: "celo-mainnet",
  venue: "v3",
  range: "7d",
  includeProtocolActors: false,
  chainIdIn: [42220, 143, 137],
  todayMidnight: TODAY_MIDNIGHT,
};

const MATCHING_ACTUAL = {
  networkId: "celo-mainnet",
  venue: "v3",
  range: "7d",
  isProtocolActorIn: [false],
  chainIdIn: [42220, 143, 137],
  todayMidnight: TODAY_MIDNIGHT,
} as const;

describe("protocolActorInForView", () => {
  it("derives the same isProtocolActorIn list as the client memo", () => {
    expect(protocolActorInForView(false)).toEqual([false]);
    expect(protocolActorInForView(true)).toEqual([false, true]);
  });
});

describe("volumeHeroViewMatches", () => {
  it("matches when every key ingredient is identical", () => {
    expect(volumeHeroViewMatches(VIEW, MATCHING_ACTUAL)).toBe(true);
  });

  it("matches the all-actors view against [false, true]", () => {
    expect(
      volumeHeroViewMatches(
        { ...VIEW, includeProtocolActors: true },
        { ...MATCHING_ACTUAL, isProtocolActorIn: [false, true] },
      ),
    ).toBe(true);
  });

  it("rejects a network mismatch", () => {
    expect(
      volumeHeroViewMatches(VIEW, {
        ...MATCHING_ACTUAL,
        networkId: "monad-mainnet",
      }),
    ).toBe(false);
  });

  it("rejects a venue mismatch", () => {
    expect(
      volumeHeroViewMatches(VIEW, { ...MATCHING_ACTUAL, venue: "v2" }),
    ).toBe(false);
  });

  it("rejects a range mismatch", () => {
    expect(
      volumeHeroViewMatches(VIEW, { ...MATCHING_ACTUAL, range: "30d" }),
    ).toBe(false);
  });

  it("rejects an actor-filter mismatch in either direction", () => {
    expect(
      volumeHeroViewMatches(VIEW, {
        ...MATCHING_ACTUAL,
        isProtocolActorIn: [false, true],
      }),
    ).toBe(false);
    expect(
      volumeHeroViewMatches(
        { ...VIEW, includeProtocolActors: true },
        MATCHING_ACTUAL,
      ),
    ).toBe(false);
  });

  it("rejects a UTC-day mismatch (midnight edge: server day N, client day N+1)", () => {
    expect(
      volumeHeroViewMatches(VIEW, {
        ...MATCHING_ACTUAL,
        todayMidnight: TODAY_MIDNIGHT + 86_400,
      }),
    ).toBe(false);
  });

  it("rejects a chain-scope mismatch", () => {
    expect(
      volumeHeroViewMatches(VIEW, {
        ...MATCHING_ACTUAL,
        chainIdIn: [137],
      }),
    ).toBe(false);
  });
});
