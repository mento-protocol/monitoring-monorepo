/**
 * Server-shell tests for `app/limit/[limitId]/page.tsx` — mirrors
 * `address-book/[address]/__tests__/page.server.test.ts`. The route resolves a
 * Broker trading-limit id from an alert into the wrapping VirtualPool's Limits
 * tab, separates a limit no VirtualPool indexes from an unreachable indexer,
 * and refuses a malformed id before any fetch runs.
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

// Two reachable virtual-pool networks sharing one Hasura endpoint, so the
// partial-failure cases are reachable and the per-chain scoping is observable,
// plus one local network the route must skip.
vi.mock("@/lib/networks", () => ({
  NETWORKS: {
    "celo-mainnet": {
      id: "celo-mainnet",
      chainId: 42220,
      hasVirtualPools: true,
      hasuraUrl: "https://example.com/v1/graphql",
    },
    "celo-sepolia": {
      id: "celo-sepolia",
      chainId: 11142220,
      hasVirtualPools: true,
      hasuraUrl: "https://example.com/v1/graphql",
    },
    "monad-mainnet": {
      id: "monad-mainnet",
      chainId: 143,
      hasVirtualPools: false,
      hasuraUrl: "https://example.com/v1/graphql",
    },
    // Relative proxy path, which Node's `fetch` rejects on the server.
    "celo-mainnet-local": {
      id: "celo-mainnet-local",
      chainId: 42220,
      hasVirtualPools: true,
      hasuraUrl: "/api/hasura/celo-mainnet-local",
    },
  },
  NETWORK_IDS: [
    "celo-mainnet",
    "celo-sepolia",
    "monad-mainnet",
    "celo-mainnet-local",
  ],
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

  it("queries only the reachable virtual-pool networks, lowercasing the id", async () => {
    requestMock.mockResolvedValue({
      BrokerTradingLimit: [{ poolId: POOL_ID }],
    });

    await expect(
      LimitResolverPage({ params: makeParams(LIMIT_ID.toUpperCase()) }),
    ).rejects.toThrow("__REDIRECT__:");
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[0]?.[0]).toMatchObject({
      document: BROKER_LIMIT_POOL,
      variables: { limitId: LIMIT_ID, chainId: 42220 },
    });
  });

  it("scopes each query to its own chain on a shared Hasura endpoint", async () => {
    requestMock.mockResolvedValue({ BrokerTradingLimit: [] });

    const markup = renderToStaticMarkup(
      await LimitResolverPage({ params: makeParams(LIMIT_ID) }),
    );

    expect(markup).toContain(MISS_COPY);
    expect(
      requestMock.mock.calls.map((call) => call[0]?.variables?.chainId),
    ).toEqual([42220, 11142220]);
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

describe("LimitResolverPage — a limit no VirtualPool indexes explains the miss", () => {
  it("renders the explanation and the id instead of redirecting", async () => {
    requestMock.mockResolvedValue({ BrokerTradingLimit: [] });

    const html = renderToStaticMarkup(
      await LimitResolverPage({ params: makeParams(LIMIT_ID) }),
    );
    expect(redirectCalls).toEqual([]);
    expect(html).toContain(MISS_COPY);
    // A row that has not bootstrapped on its first indexed swap looks the same
    // as an unwrapped exchange (ADR 0103), so the copy must not assert either.
    expect(html).toContain("until its first indexed swap");
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
