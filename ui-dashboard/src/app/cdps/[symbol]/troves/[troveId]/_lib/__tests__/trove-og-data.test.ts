import { beforeEach, describe, expect, it, vi } from "vitest";

const { capturedCacheKeyParts, capturedCacheOptions } = vi.hoisted(() => ({
  capturedCacheKeyParts: [] as string[][],
  capturedCacheOptions: [] as unknown[],
}));

vi.mock("next/cache", () => ({
  unstable_cache: <T extends (...args: never[]) => unknown>(
    fn: T,
    keyParts?: string[],
    options?: unknown,
  ) => {
    if (keyParts) capturedCacheKeyParts.push(keyParts);
    capturedCacheOptions.push(options);
    return fn;
  },
}));

vi.mock("@/lib/networks", () => ({
  NETWORKS: {
    "celo-mainnet": {
      id: "celo-mainnet",
      label: "Celo",
      chainId: 42220,
      hasuraUrl: "https://hasura.example/v1/graphql",
      hasuraSecret: "",
      explorerBaseUrl: "https://celoscan.io",
      tokenSymbols: {},
      addressLabels: {},
      local: false,
      testnet: false,
      hasVirtualPools: true,
      contractsNamespace: "mainnet",
    },
  },
}));

vi.mock("@/lib/graphql-fetch", () => {
  const MockGraphQLClient = vi.fn();
  MockGraphQLClient.prototype.request = vi.fn();
  return { GraphQLClient: MockGraphQLClient };
});

import { GraphQLClient } from "@/lib/graphql-fetch";
import { CDP_TROVE_OG_BY_ID, CDP_TROVE_OG_COLLATERALS } from "@/lib/queries";
import {
  fetchTroveOgDataForMetadata,
  fetchTroveOgDataUncached,
  TROVE_OG_MAX_DATA_AGE_MS,
  troveOgDataIsFresh,
  type TroveOgData,
} from "../trove-og-data";

const D18 = BigInt(10) ** BigInt(18);
const NOW_MS = Date.UTC(2026, 7, 28, 12, 0, 0);

function wei(amount: number): string {
  return (BigInt(amount) * D18).toString();
}

const collateral = {
  id: "gbpm",
  chainId: 42220,
  symbol: "GBPm",
  mcrBps: 11_000,
};

const trove = {
  id: "gbpm-0x8abc",
  troveId: "0x8abc",
  status: "active",
  debt: wei(28_081),
  coll: wei(44_791),
  icrBps: 11_710,
  openedAt: "1787000000",
  closedAt: null,
  lastUpdatedAt: "1787900000",
};

function mockHealthyQueries(overrides: Record<string, unknown> = {}) {
  (
    GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
  ).mockImplementation(async ({ document }: { document: string }) => {
    if (document === CDP_TROVE_OG_COLLATERALS) {
      return { LiquityCollateral: [collateral] };
    }
    if (document === CDP_TROVE_OG_BY_ID) {
      return { Trove: [{ ...trove, ...overrides }] };
    }
    throw new Error("unexpected query");
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  vi.clearAllMocks();
});

describe("trove OG cache contract", () => {
  it("salts the cache by deploy and endpoint and bounds revalidation", () => {
    expect(capturedCacheKeyParts).toEqual([
      [
        "trove-og",
        process.env.VERCEL_DEPLOYMENT_ID ??
          process.env.VERCEL_GIT_COMMIT_SHA ??
          "dev",
        "celo-mainnet=https://hasura.example/v1/graphql",
      ],
    ]);
    expect(capturedCacheOptions).toEqual([
      { revalidate: 60, tags: ["trove-og"] },
    ]);
  });
});

describe("fetchTroveOgDataUncached", () => {
  it("resolves the exact trove and formats the four visible values", async () => {
    mockHealthyQueries();

    const data = await fetchTroveOgDataUncached("GBPM", "0x0000000000008ABC");

    expect(data).toMatchObject({
      symbol: "GBPm",
      troveId: "0x8abc",
      statusLabel: "Active",
      statusTone: "healthy",
      collateral: "44.79K USDm",
      debt: "28.08K GBPm",
      icr: "117.10%",
      icrTone: "warning",
      openedDate: "2026-08-17",
      lastEventLabel: "Last indexed",
      lastEventDate: "2026-08-28",
      fetchedAtMs: NOW_MS,
    });
    expect(GraphQLClient.prototype.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        document: CDP_TROVE_OG_BY_ID,
        variables: { troveEntityId: "gbpm-0x8abc" },
      }),
    );
  });

  it("uses the close timestamp and status when the position has ended", async () => {
    mockHealthyQueries({ status: "liquidated", closedAt: "1787800000" });

    const data = await fetchTroveOgDataUncached("gbpm", "0x8abc");

    expect(data).toMatchObject({
      statusLabel: "Liquidated",
      statusTone: "critical",
      lastEventLabel: "Closed",
      lastEventDate: "2026-08-27",
    });
  });

  it("returns unavailable for invalid ids, missing rows, and malformed values", async () => {
    expect(await fetchTroveOgDataUncached("gbpm", "not-a-trove")).toBeNull();
    expect(GraphQLClient.prototype.request).not.toHaveBeenCalled();

    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({ LiquityCollateral: [] });
    expect(await fetchTroveOgDataUncached("gbpm", "0x8abc")).toBeNull();

    vi.clearAllMocks();
    mockHealthyQueries({ debt: "malformed" });
    expect(await fetchTroveOgDataUncached("gbpm", "0x8abc")).toBeNull();
  });

  it("returns unavailable when required collateral or timestamp data is malformed", async () => {
    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation(async ({ document }: { document: string }) => {
      if (document === CDP_TROVE_OG_COLLATERALS) {
        return {
          LiquityCollateral: [{ ...collateral, mcrBps: Number.NaN }],
        };
      }
      return { Trove: [trove] };
    });
    expect(await fetchTroveOgDataUncached("gbpm", "0x8abc")).toBeNull();

    vi.clearAllMocks();
    mockHealthyQueries({ lastUpdatedAt: "9999999999999999" });
    expect(await fetchTroveOgDataUncached("gbpm", "0x8abc")).toBeNull();
  });

  it("returns unavailable when Hasura fails", async () => {
    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("network"));

    expect(await fetchTroveOgDataUncached("gbpm", "0x8abc")).toBeNull();
  });
});

describe("fetchTroveOgDataForMetadata", () => {
  it("uses the cached path with canonical parameters", async () => {
    mockHealthyQueries();

    const data = await fetchTroveOgDataForMetadata("GBPM", "0x0008ABC");

    expect(data?.troveId).toBe("0x8abc");
    expect(data?.symbol).toBe("GBPm");
  });

  it("rejects a cached snapshot after the five-minute freshness envelope", () => {
    const data = {
      fetchedAtMs: NOW_MS,
    } as TroveOgData;

    expect(troveOgDataIsFresh(data, NOW_MS + TROVE_OG_MAX_DATA_AGE_MS)).toBe(
      true,
    );
    expect(
      troveOgDataIsFresh(data, NOW_MS + TROVE_OG_MAX_DATA_AGE_MS + 1),
    ).toBe(false);
    expect(troveOgDataIsFresh(data, NOW_MS - 1)).toBe(false);
  });
});
