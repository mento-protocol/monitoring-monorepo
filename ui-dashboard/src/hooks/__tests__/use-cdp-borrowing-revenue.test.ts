/**
 * Targeted tests for the paginator helpers inside `use-cdp-borrowing-revenue`.
 *
 * Strategy: spy on `fetchPaginatedRows` (the canonical helper the three thin
 * wrappers now delegate to) to verify:
 *   (a) a fresh AbortSignal.timeout is created per page, not shared across
 *       the whole pagination loop (the bug fixed by this PR), and
 *   (b) boundary-duplicate rows are deduped so windowed totals can't
 *       double-count when an insert lands between page requests.
 *
 * We do NOT render the hook or exercise SWR — that's covered by the existing
 * cdp-borrowing-revenue.test.ts (pure math) and revenue-page-client.test.tsx
 * (mocked hook). These tests are unit-level: they drive the GraphQL client
 * mock directly through `fetchAllNetworks.fetchPaginatedRows`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// ---------------------------------------------------------------------------
// graphql-request mock
// ---------------------------------------------------------------------------

vi.mock("graphql-request", () => {
  const MockGraphQLClient = vi.fn();
  MockGraphQLClient.prototype.request = vi.fn();
  return { GraphQLClient: MockGraphQLClient };
});

import { GraphQLClient } from "graphql-request";

// ---------------------------------------------------------------------------
// Import the module-private helpers via the public fetchPaginatedRows export.
// We test fetchPaginatedRows directly since that's the canonical function the
// three wrappers delegate to, and it's now exported from fetch-all-networks.
// ---------------------------------------------------------------------------

import {
  fetchPaginatedRows,
  warnedCapKeys,
  partialPageLastCapturedAt,
} from "@/lib/fetch-all-networks";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(): InstanceType<typeof GraphQLClient> {
  return new GraphQLClient("https://example.com/graphql");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchPaginatedRows — AbortSignal.timeout per page", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    warnedCapKeys.clear();
    partialPageLastCapturedAt.clear();
  });

  it("calls AbortSignal.timeout once per page, not once for the whole loop", async () => {
    const client = makeClient();
    const PAGE_SIZE = 1000;

    // Simulate 2 full pages then a partial page (3 pages total → 3 signals).
    const fullPage = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      id: `row-${i}`,
    }));
    const partialPage = [{ id: "row-last" }];

    const requestMock = vi
      .mocked(client.request)
      .mockResolvedValueOnce({ TestKey: fullPage })
      .mockResolvedValueOnce({ TestKey: fullPage })
      .mockResolvedValueOnce({ TestKey: partialPage });

    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    await fetchPaginatedRows({
      client,
      query: "query { TestKey { id } }",
      responseKey: "TestKey",
      network: "celo-mainnet",
      variablesFor: (page) => ({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
      dedupKey: (r: { id: string }) => r.id,
    });

    // 3 pages → 3 separate AbortSignal.timeout() calls (one per request).
    expect(timeoutSpy).toHaveBeenCalledTimes(3);
    expect(requestMock).toHaveBeenCalledTimes(3);
  });

  it("creates distinct signal objects for each page (not the same reference)", async () => {
    const client = makeClient();
    const PAGE_SIZE = 1000;

    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      id: `p1-${i}`,
    }));
    const page2 = [{ id: "p2-0" }];

    // Capture the signal passed into each client.request() call. Use a
    // dedicated call counter rather than deriving the page index from
    // capturedSignals.length so the fixture selection can't desync if a
    // future code path ever omits the signal field.
    const capturedSignals: AbortSignal[] = [];
    let callCount = 0;
    type RequestArg = Parameters<typeof client.request>[0];
    vi.mocked(client.request).mockImplementation(async (opts: RequestArg) => {
      const sig =
        opts != null && typeof opts === "object" && "signal" in opts
          ? (opts as { signal?: AbortSignal | null }).signal
          : undefined;
      if (sig) capturedSignals.push(sig);
      return callCount++ === 0 ? { TestKey: page1 } : { TestKey: page2 };
    });

    await fetchPaginatedRows({
      client,
      query: "query { TestKey { id } }",
      responseKey: "TestKey",
      network: "celo-mainnet",
      variablesFor: (page) => ({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
      dedupKey: (r: { id: string }) => r.id,
    });

    // Each page must get its own signal object — not the same reference.
    expect(capturedSignals).toHaveLength(2);
    expect(capturedSignals[0]).not.toBe(capturedSignals[1]);
  });
});

describe("fetchPaginatedRows — boundary-duplicate dedup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    warnedCapKeys.clear();
    partialPageLastCapturedAt.clear();
  });

  it("deduplicates a row that appears at the tail of one page and head of the next", async () => {
    const client = makeClient();
    const PAGE_SIZE = 1000;

    // Page 0: 1000 rows, last row has id "boundary-row".
    const page0 = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      id: i === PAGE_SIZE - 1 ? "boundary-row" : `r0-${i}`,
    }));
    // Page 1: first row is the same "boundary-row" (re-emitted by Hasura
    // under concurrent insert), then a short tail.
    const page1 = [
      { id: "boundary-row" }, // duplicate
      { id: "r1-0" },
      { id: "r1-1" },
    ];

    vi.mocked(client.request)
      .mockResolvedValueOnce({ TestKey: page0 })
      .mockResolvedValueOnce({ TestKey: page1 });

    const result = await fetchPaginatedRows({
      client,
      query: "query { TestKey { id } }",
      responseKey: "TestKey",
      network: "celo-mainnet",
      variablesFor: (page) => ({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
      dedupKey: (r: { id: string }) => r.id,
    });

    // Total unique rows: 1000 (page0) + 2 new from page1 (r1-0, r1-1).
    // "boundary-row" must appear exactly once.
    expect(result.rows).toHaveLength(PAGE_SIZE + 2);
    const ids = result.rows.map((r) => r.id);
    const boundaryCount = ids.filter((id) => id === "boundary-row").length;
    expect(boundaryCount).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.error).toBeNull();
  });

  it("returns all rows without duplicates across three pages", async () => {
    const client = makeClient();
    const PAGE_SIZE = 1000;

    const page0 = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      id: `r-${i}`,
    }));
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      id: `r-${PAGE_SIZE + i}`,
    }));
    const page2 = [{ id: "r-last" }];

    vi.mocked(client.request)
      .mockResolvedValueOnce({ TestKey: page0 })
      .mockResolvedValueOnce({ TestKey: page1 })
      .mockResolvedValueOnce({ TestKey: page2 });

    const result = await fetchPaginatedRows({
      client,
      query: "query { TestKey { id } }",
      responseKey: "TestKey",
      network: "celo-mainnet",
      variablesFor: (page) => ({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
      dedupKey: (r: { id: string }) => r.id,
    });

    const uniqueIds = new Set(result.rows.map((r) => r.id));
    expect(result.rows).toHaveLength(uniqueIds.size);
    expect(result.rows).toHaveLength(PAGE_SIZE * 2 + 1);
  });
});
