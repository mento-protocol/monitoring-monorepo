/**
 * Server-shell tests for `app/limit/[limitId]/page.tsx` — mirrors
 * `address-book/[address]/__tests__/page.server.test.ts`. The route resolves a
 * Broker trading-limit id from an alert into the wrapping VirtualPool's Limits
 * tab, separates an unwrapped v2 exchange from an unreachable indexer, and
 * refuses a malformed id before any fetch runs.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BROKER_LIMIT_POOL } from "@/lib/queries/limit-lookup";

const redirectCalls: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    redirectCalls.push(path);
    throw new Error(`__REDIRECT__:${path}`);
  },
  notFound: () => {
    throw new Error("__NOT_FOUND__");
  },
}));

const requestMock = vi.fn();
vi.mock("@/lib/og-graphql-client", () => ({
  makeOgGraphQLClient: () => ({ request: requestMock }),
}));

// Two virtual-pool networks, so the partial-failure cases are reachable.
vi.mock("@/lib/networks", () => ({
  NETWORKS: {
    "celo-mainnet": {
      id: "celo-mainnet",
      hasVirtualPools: true,
      hasuraUrl: "https://example.com/v1/graphql",
    },
    "celo-sepolia": {
      id: "celo-sepolia",
      hasVirtualPools: true,
      hasuraUrl: "https://example.com/v1/graphql",
    },
    "monad-mainnet": {
      id: "monad-mainnet",
      hasVirtualPools: false,
      hasuraUrl: "https://example.com/v1/graphql",
    },
  },
  NETWORK_IDS: ["celo-mainnet", "celo-sepolia", "monad-mainnet"],
  isConfiguredNetworkId: () => true,
}));

import LimitResolverPage from "../page";

const LIMIT_ID = `0x${"d5".repeat(32)}`;
const POOL_ID = "42220-0x1d013077b00b28038a3f1e7a29aba34e12e562e9";
const MISS_COPY = "No pool page for this trading limit";
const UNAVAILABLE_COPY = "Could not look up this trading limit";

function makeParams(limitId: string): Promise<{ limitId: string }> {
  return Promise.resolve({ limitId });
}

beforeEach(() => {
  redirectCalls.length = 0;
  requestMock.mockReset();
});

describe("LimitResolverPage — malformed ids never reach Hasura", () => {
  it.each([
    ["non-hex garbage", "not-a-limit-id"],
    ["malformed percent-encoding", "%zz"],
    ["empty id", ""],
    ["a 40-hex address", `0x${"a".repeat(40)}`],
    ["65 hex digits", `0x${"a".repeat(65)}`],
  ])("responds 404 for %s", async (_label, raw) => {
    await expect(
      LimitResolverPage({ params: makeParams(raw) }),
    ).rejects.toThrow("__NOT_FOUND__");
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe("LimitResolverPage — a wrapped exchange redirects to its pool", () => {
  it("sends the responder to the pool page's Limits tab", async () => {
    requestMock.mockResolvedValue({
      BrokerTradingLimit: [{ poolId: POOL_ID }],
    });

    await expect(
      LimitResolverPage({ params: makeParams(LIMIT_ID) }),
    ).rejects.toThrow(
      `__REDIRECT__:/pool/${encodeURIComponent(POOL_ID)}?tab=limits`,
    );
    expect(redirectCalls).toEqual([
      `/pool/${encodeURIComponent(POOL_ID)}?tab=limits`,
    ]);
  });

  it("queries only the virtual-pool networks, lowercasing the id", async () => {
    requestMock.mockResolvedValue({
      BrokerTradingLimit: [{ poolId: POOL_ID }],
    });

    await expect(
      LimitResolverPage({ params: makeParams(LIMIT_ID.toUpperCase()) }),
    ).rejects.toThrow("__REDIRECT__:");
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[0]?.[0]).toMatchObject({
      document: BROKER_LIMIT_POOL,
      variables: { limitId: LIMIT_ID },
    });
  });

  it("redirects when one network fails and another holds the row", async () => {
    requestMock
      .mockRejectedValueOnce(new Error("hasura down"))
      .mockResolvedValueOnce({ BrokerTradingLimit: [{ poolId: POOL_ID }] });

    await expect(
      LimitResolverPage({ params: makeParams(LIMIT_ID) }),
    ).rejects.toThrow("__REDIRECT__:");
    expect(redirectCalls).toEqual([
      `/pool/${encodeURIComponent(POOL_ID)}?tab=limits`,
    ]);
  });
});

describe("LimitResolverPage — an unwrapped exchange explains the miss", () => {
  it("renders the explanation and the id instead of redirecting", async () => {
    requestMock.mockResolvedValue({ BrokerTradingLimit: [] });

    const html = renderToStaticMarkup(
      await LimitResolverPage({ params: makeParams(LIMIT_ID) }),
    );
    expect(redirectCalls).toEqual([]);
    expect(html).toContain(MISS_COPY);
    expect(html).toContain(LIMIT_ID);
    expect(html).toContain('href="/pools"');
  });
});

describe("LimitResolverPage — a failed lookup never claims a miss", () => {
  it("says the lookup failed when the endpoint fails", async () => {
    requestMock.mockRejectedValue(new Error("hasura down"));

    const html = renderToStaticMarkup(
      await LimitResolverPage({ params: makeParams(LIMIT_ID) }),
    );
    expect(redirectCalls).toEqual([]);
    expect(html).toContain(UNAVAILABLE_COPY);
    expect(html).not.toContain(MISS_COPY);
    expect(html).toContain(LIMIT_ID);
  });

  it("says the lookup failed when the response fails the schema", async () => {
    requestMock.mockResolvedValue({ BrokerTradingLimit: [{ poolId: 42 }] });

    const html = renderToStaticMarkup(
      await LimitResolverPage({ params: makeParams(LIMIT_ID) }),
    );
    expect(redirectCalls).toEqual([]);
    expect(html).toContain(UNAVAILABLE_COPY);
    expect(html).not.toContain(MISS_COPY);
  });

  it("says the lookup failed when only one network answers empty", async () => {
    requestMock
      .mockRejectedValueOnce(new Error("hasura down"))
      .mockResolvedValueOnce({ BrokerTradingLimit: [] });

    const html = renderToStaticMarkup(
      await LimitResolverPage({ params: makeParams(LIMIT_ID) }),
    );
    expect(redirectCalls).toEqual([]);
    expect(html).toContain(UNAVAILABLE_COPY);
    expect(html).not.toContain(MISS_COPY);
  });
});
