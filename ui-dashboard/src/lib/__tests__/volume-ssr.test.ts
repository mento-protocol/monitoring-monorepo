import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROKER_VOLUME_TODAY_TRADERS,
  BROKER_VOLUME_WINDOW_FIRSTDAY_LATEST,
  BROKER_VOLUME_WINDOW_LATEST,
  VOLUME_TODAY_TRADERS,
  VOLUME_WINDOW_FIRSTDAY_LATEST,
  VOLUME_WINDOW_LATEST,
} from "@/lib/queries/volume";
import { HASURA_TIMEOUT_MS } from "@/lib/hasura-timeout";

const requestMock = vi.fn();
const makeOgGraphQLClientMock = vi.fn((network: unknown) => {
  void network;
  return { request: requestMock };
});

vi.mock("next/cache", () => ({
  unstable_cache: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

vi.mock("@/lib/og-graphql-client", () => ({
  makeOgGraphQLClient: (network: unknown) => makeOgGraphQLClientMock(network),
}));

const networksState = vi.hoisted(() => ({
  hasuraUrl: "https://example.com/v1/graphql",
}));

vi.mock("@/lib/networks", () => ({
  DEFAULT_NETWORK: "celo-mainnet",
  NETWORKS: {
    "celo-mainnet": {
      id: "celo-mainnet",
      get hasuraUrl() {
        return networksState.hasuraUrl;
      },
    },
  },
}));

import { fetchVolumeHeroForSSR } from "../volume-ssr";

const TODAY_MIDNIGHT = 1_780_012_800;

const WINDOW_ROWS = {
  volumeWindowSnapshots: [
    {
      id: "42220-7d-1779840000",
      chainId: 42220,
      windowKey: "7d",
      snapshotDay: "1779840000",
      windowStartDay: "1779321600",
      totalVolumeUsdWei: "1000000000000000000000",
      totalVolumeUsdWeiIncludingProtocolActors: "2000000000000000000000",
      totalSwapCount: 50,
      totalSwapCountIncludingProtocolActors: 80,
      uniqueTraders: 10,
      uniqueTradersIncludingProtocolActors: 12,
    },
  ],
};
const TODAY_ROWS = {
  volumeTodayTraders: [
    {
      chainId: 42220,
      trader: "0xabc",
      volumeUsdWei: "42000000000000000000",
      swapCount: 3,
      isProtocolActor: false,
    },
  ],
};
const FIRSTDAY_ROWS = {
  volumeWindowFirstDaySnapshots: [
    {
      chainId: 42220,
      snapshotDay: "1779840000",
      firstDayVolumeUsdWei: "100000000000000000000",
      firstDayVolumeUsdWeiIncludingProtocolActors: "100000000000000000000",
      firstDaySwapCount: 5,
      firstDaySwapCountIncludingProtocolActors: 5,
      firstDayExclusiveUniqueTraders: 1,
      firstDayExclusiveUniqueTradersIncludingProtocolActors: 1,
    },
  ],
};
const BROKER_WINDOW_ROWS = {
  brokerVolumeWindowSnapshots: WINDOW_ROWS.volumeWindowSnapshots,
};
const BROKER_TODAY_ROWS = {
  brokerVolumeTodayTraders: TODAY_ROWS.volumeTodayTraders,
};
const BROKER_FIRSTDAY_ROWS = {
  brokerVolumeWindowFirstDaySnapshots:
    FIRSTDAY_ROWS.volumeWindowFirstDaySnapshots,
};

function validHeroResponses(): Record<string, unknown> {
  return {
    [VOLUME_WINDOW_LATEST]: WINDOW_ROWS,
    [VOLUME_TODAY_TRADERS]: TODAY_ROWS,
    [VOLUME_WINDOW_FIRSTDAY_LATEST]: FIRSTDAY_ROWS,
    [BROKER_VOLUME_WINDOW_LATEST]: BROKER_WINDOW_ROWS,
    [BROKER_VOLUME_TODAY_TRADERS]: BROKER_TODAY_ROWS,
    [BROKER_VOLUME_WINDOW_FIRSTDAY_LATEST]: BROKER_FIRSTDAY_ROWS,
  };
}

function respondByDocument(
  responses: Record<string, unknown>,
): (request: { document: string }) => unknown {
  return ({ document }) => {
    if (document in responses) {
      const value = responses[document];
      if (value instanceof Error) throw value;
      return value;
    }
    throw new Error("unexpected query");
  };
}

describe("fetchVolumeHeroForSSR", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    networksState.hasuraUrl = "https://example.com/v1/graphql";
  });

  it("prefetches the v3 hero trio with timeout-bound requests and a matching view descriptor", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    requestMock.mockImplementation(
      respondByDocument({
        [VOLUME_WINDOW_LATEST]: WINDOW_ROWS,
        [VOLUME_TODAY_TRADERS]: TODAY_ROWS,
        [VOLUME_WINDOW_FIRSTDAY_LATEST]: FIRSTDAY_ROWS,
      }),
    );

    const result = await fetchVolumeHeroForSSR(
      "v3",
      "7d",
      false,
      TODAY_MIDNIGHT,
    );

    expect(result?.view).toEqual({
      networkId: "celo-mainnet",
      venue: "v3",
      range: "7d",
      includeProtocolActors: false,
      todayMidnight: TODAY_MIDNIGHT,
    });
    expect(result?.heroV3).toEqual(WINDOW_ROWS);
    expect(result?.todayV3).toEqual(TODAY_ROWS);
    expect(result?.firstDayV3).toEqual(FIRSTDAY_ROWS);
    expect(result?.heroV2).toBeUndefined();

    expect(requestMock).toHaveBeenCalledTimes(3);
    const byDocument = new Map(
      requestMock.mock.calls.map(([request]) => [
        (request as { document: string }).document,
        request as { variables: unknown; signal: AbortSignal },
      ]),
    );
    expect(byDocument.get(VOLUME_WINDOW_LATEST)?.variables).toEqual({
      windowKey: "7d",
    });
    expect(byDocument.get(VOLUME_TODAY_TRADERS)?.variables).toEqual({
      todayMidnight: TODAY_MIDNIGHT,
      isProtocolActorIn: [false],
    });
    expect(byDocument.get(VOLUME_WINDOW_FIRSTDAY_LATEST)?.variables).toEqual({
      windowKey: "7d",
    });
    // Two budgets: the shared primary deadline plus the tighter independent
    // budget for the optional firstDay slice, so a hung optional query can't
    // hold TTFB to the full shared deadline on a cache miss.
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenCalledWith(HASURA_TIMEOUT_MS);
    expect(timeoutSpy).toHaveBeenCalledWith(2_000);
    const signalOf = (document: string) =>
      (byDocument.get(document) as { signal: AbortSignal }).signal;
    // Primaries share one deadline; firstDay rides its own.
    expect(signalOf(VOLUME_WINDOW_LATEST)).toBe(signalOf(VOLUME_TODAY_TRADERS));
    expect(signalOf(VOLUME_WINDOW_FIRSTDAY_LATEST)).not.toBe(
      signalOf(VOLUME_WINDOW_LATEST),
    );
  });

  it("prefetches the broker variants with [false, true] actors for the v2 all-actors view", async () => {
    requestMock.mockImplementation(
      respondByDocument({
        [BROKER_VOLUME_WINDOW_LATEST]: BROKER_WINDOW_ROWS,
        [BROKER_VOLUME_TODAY_TRADERS]: BROKER_TODAY_ROWS,
        [BROKER_VOLUME_WINDOW_FIRSTDAY_LATEST]: BROKER_FIRSTDAY_ROWS,
      }),
    );

    const result = await fetchVolumeHeroForSSR(
      "v2",
      "90d",
      true,
      TODAY_MIDNIGHT,
    );

    expect(result?.view).toEqual({
      networkId: "celo-mainnet",
      venue: "v2",
      range: "90d",
      includeProtocolActors: true,
      todayMidnight: TODAY_MIDNIGHT,
    });
    expect(result?.heroV2).toEqual(BROKER_WINDOW_ROWS);
    expect(result?.todayV2).toEqual(BROKER_TODAY_ROWS);
    expect(result?.firstDayV2).toEqual(BROKER_FIRSTDAY_ROWS);
    expect(result?.heroV3).toBeUndefined();
    const todayCall = requestMock.mock.calls.find(
      ([request]) =>
        (request as { document: string }).document ===
        BROKER_VOLUME_TODAY_TRADERS,
    );
    expect((todayCall?.[0] as { variables: unknown }).variables).toEqual({
      todayMidnight: TODAY_MIDNIGHT,
      isProtocolActorIn: [false, true],
    });
  });

  it("returns undefined overall when the primary window query fails", async () => {
    requestMock.mockImplementation(
      respondByDocument({
        [VOLUME_WINDOW_LATEST]: new Error("Hasura down"),
        [VOLUME_TODAY_TRADERS]: TODAY_ROWS,
        [VOLUME_WINDOW_FIRSTDAY_LATEST]: FIRSTDAY_ROWS,
      }),
    );

    await expect(
      fetchVolumeHeroForSSR("v3", "7d", false, TODAY_MIDNIGHT),
    ).resolves.toBeUndefined();
  });

  it("returns undefined overall when the today-partial query fails", async () => {
    requestMock.mockImplementation(
      respondByDocument({
        [VOLUME_WINDOW_LATEST]: WINDOW_ROWS,
        [VOLUME_TODAY_TRADERS]: new Error("timeout"),
        [VOLUME_WINDOW_FIRSTDAY_LATEST]: FIRSTDAY_ROWS,
      }),
    );

    await expect(
      fetchVolumeHeroForSSR("v3", "7d", false, TODAY_MIDNIGHT),
    ).resolves.toBeUndefined();
  });

  it("keeps the primary pair when only the firstDay catch-up slice fails", async () => {
    requestMock.mockImplementation(
      respondByDocument({
        [VOLUME_WINDOW_LATEST]: WINDOW_ROWS,
        [VOLUME_TODAY_TRADERS]: TODAY_ROWS,
        [VOLUME_WINDOW_FIRSTDAY_LATEST]: new Error(
          "field firstDayVolumeUsdWei not found",
        ),
      }),
    );

    const result = await fetchVolumeHeroForSSR(
      "v3",
      "7d",
      false,
      TODAY_MIDNIGHT,
    );

    expect(result?.heroV3).toEqual(WINDOW_ROWS);
    expect(result?.todayV3).toEqual(TODAY_ROWS);
    expect(result?.firstDayV3).toBeUndefined();
  });

  it.each([
    ["v3 window", "v3", VOLUME_WINDOW_LATEST],
    ["v3 today", "v3", VOLUME_TODAY_TRADERS],
    ["v2 window", "v2", BROKER_VOLUME_WINDOW_LATEST],
    ["v2 today", "v2", BROKER_VOLUME_TODAY_TRADERS],
  ] as const)(
    "drops the all-or-nothing primary pair when the %s payload is malformed",
    async (_name, venue, malformedDocument) => {
      const responses = validHeroResponses();
      responses[malformedDocument] = { payload: "must-not-cross-or-log" };
      requestMock.mockImplementation(respondByDocument(responses));
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      try {
        await expect(
          fetchVolumeHeroForSSR(venue, "7d", false, TODAY_MIDNIGHT),
        ).resolves.toBeUndefined();
        expect(consoleError).not.toHaveBeenCalled();
      } finally {
        consoleError.mockRestore();
      }
    },
  );

  it.each([
    ["v3", VOLUME_WINDOW_FIRSTDAY_LATEST],
    ["v2", BROKER_VOLUME_WINDOW_FIRSTDAY_LATEST],
  ] as const)(
    "drops only the malformed %s firstDay extension and keeps valid primaries",
    async (venue, malformedDocument) => {
      const responses = validHeroResponses();
      responses[malformedDocument] = { payload: "wrong-shape" };
      requestMock.mockImplementation(respondByDocument(responses));

      const result = await fetchVolumeHeroForSSR(
        venue,
        "7d",
        false,
        TODAY_MIDNIGHT,
      );

      if (venue === "v3") {
        expect(result?.heroV3).toEqual(WINDOW_ROWS);
        expect(result?.todayV3).toEqual(TODAY_ROWS);
        expect(result?.firstDayV3).toBeUndefined();
      } else {
        expect(result?.heroV2).toEqual(BROKER_WINDOW_ROWS);
        expect(result?.todayV2).toEqual(BROKER_TODAY_ROWS);
        expect(result?.firstDayV2).toBeUndefined();
      }
    },
  );

  it("returns undefined when the default network has no Hasura URL", async () => {
    networksState.hasuraUrl = "";

    await expect(
      fetchVolumeHeroForSSR("v3", "7d", false, TODAY_MIDNIGHT),
    ).resolves.toBeUndefined();
    expect(requestMock).not.toHaveBeenCalled();
  });
});
