import { describe, it, expect, vi } from "vitest";
import {
  ARKHAM_TAG,
  ArkhamAuthError,
  ArkhamRateLimitedError,
  RATE_LIMIT_BACKOFF_MS,
  enrichBatch,
  fetchEnrichedAddress,
  fetchHealth,
  filterCandidates,
  hasUsableLabel,
  mergeRefreshEntry,
  toAddressEntry,
  type ArkhamEnrichedAddress,
} from "@/lib/arkham";
import type { AddressEntry } from "@/lib/address-labels-shared";

function makeArkhamResponse(
  overrides: Partial<ArkhamEnrichedAddress> = {},
): ArkhamEnrichedAddress {
  return {
    address: "0xabc",
    chain: "celo",
    depositServiceID: null,
    arkhamEntity: null,
    arkhamLabel: null,
    isUserAddress: null,
    contract: null,
    tags: [],
    entityPredictions: [],
    ...overrides,
  };
}

type MockFetchEntry =
  | { status: number; body?: unknown; ok?: boolean }
  | ((url: string, init: RequestInit) => Promise<Response> | Response);

function mockFetch(responses: MockFetchEntry[]): typeof fetch {
  let i = 0;
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const r = responses[i++];
    if (!r) throw new Error(`unexpected fetch call ${i}: ${url}`);
    if (typeof r === "function") {
      return r(String(url), init ?? {});
    }
    return new Response(r.body !== undefined ? JSON.stringify(r.body) : null, {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("hasUsableLabel", () => {
  it("returns true when arkhamLabel is present", () => {
    expect(
      hasUsableLabel(
        makeArkhamResponse({
          arkhamLabel: {
            name: "Hot Wallet",
            address: "0xabc",
            chainType: "evm",
          },
        }),
      ),
    ).toBe(true);
  });

  it("returns true when arkhamEntity is present", () => {
    expect(
      hasUsableLabel(
        makeArkhamResponse({
          arkhamEntity: {
            id: "binance",
            name: "Binance",
            type: "exchange",
            service: null,
          },
        }),
      ),
    ).toBe(true);
  });

  it("returns true when entity prediction confidence >= 0.85", () => {
    expect(
      hasUsableLabel(
        makeArkhamResponse({
          entityPredictions: [
            { entityId: "binance", confidence: 0.9, reason: "ml" },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("returns false when prediction confidence is below threshold", () => {
    expect(
      hasUsableLabel(
        makeArkhamResponse({
          entityPredictions: [
            { entityId: "binance", confidence: 0.7, reason: "ml" },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("returns false when nothing is present", () => {
    expect(hasUsableLabel(makeArkhamResponse())).toBe(false);
  });
});

describe("toAddressEntry", () => {
  it("returns null when nothing is usable", () => {
    expect(toAddressEntry(makeArkhamResponse())).toBeNull();
  });

  it("prefers arkhamLabel over entity name", () => {
    const entry = toAddressEntry(
      makeArkhamResponse({
        arkhamLabel: {
          name: "Binance Hot Wallet 14",
          address: "0xabc",
          chainType: "evm",
        },
        arkhamEntity: {
          id: "binance",
          name: "Binance",
          type: "exchange",
          service: null,
        },
      }),
    );
    expect(entry?.name).toBe("Binance Hot Wallet 14");
  });

  it("falls back to entity name without label", () => {
    const entry = toAddressEntry(
      makeArkhamResponse({
        arkhamEntity: {
          id: "binance",
          name: "Binance",
          type: "exchange",
          service: null,
        },
      }),
    );
    expect(entry?.name).toBe("Binance");
  });

  it("attaches arkham + entity type + tag slugs", () => {
    const entry = toAddressEntry(
      makeArkhamResponse({
        arkhamEntity: {
          id: "binance",
          name: "Binance",
          type: "exchange",
          service: null,
        },
        tags: [
          { id: "t1", name: "CEX", slug: "cex" },
          { id: "t2", name: "Whale", slug: "whale" },
        ],
      }),
    );
    expect(entry?.tags).toContain(ARKHAM_TAG);
    expect(entry?.tags).toContain("exchange");
    expect(entry?.tags).toContain("cex");
    expect(entry?.tags).toContain("whale");
  });

  it("dedups overlap between entity type and tags", () => {
    const entry = toAddressEntry(
      makeArkhamResponse({
        arkhamEntity: {
          id: "x",
          name: "X",
          type: "exchange",
          service: null,
        },
        tags: [{ id: "t1", name: "Exchange", slug: "exchange" }],
      }),
    );
    const occurrences = (entry?.tags ?? []).filter(
      (t) => t === "exchange",
    ).length;
    expect(occurrences).toBe(1);
  });

  it("flags ML-only labels with a confidence note", () => {
    const entry = toAddressEntry(
      makeArkhamResponse({
        entityPredictions: [
          { entityId: "binance", confidence: 0.92, reason: "ml" },
        ],
      }),
    );
    expect(entry?.notes).toMatch(/92% confidence/);
  });

  it("does not add a note when label/entity carry the data", () => {
    const entry = toAddressEntry(
      makeArkhamResponse({
        arkhamLabel: { name: "Binance 14", address: "0x", chainType: "evm" },
        entityPredictions: [
          { entityId: "binance", confidence: 0.99, reason: "ml" },
        ],
      }),
    );
    expect(entry?.notes).toBeUndefined();
  });

  it("returns null when arkhamLabel is whitespace and no fallback exists", () => {
    // The pre-fix bug: `?? `chained on label.trim()` (which returns "") kept
    // the empty string, persisting an empty-named entry.
    const entry = toAddressEntry(
      makeArkhamResponse({
        arkhamLabel: { name: "   ", address: "0xabc", chainType: "evm" },
      }),
    );
    expect(entry).toBeNull();
  });

  it("falls through whitespace-only label to entity name", () => {
    const entry = toAddressEntry(
      makeArkhamResponse({
        arkhamLabel: { name: "   ", address: "0xabc", chainType: "evm" },
        arkhamEntity: {
          id: "binance",
          name: "Binance",
          type: "exchange",
          service: null,
        },
      }),
    );
    expect(entry?.name).toBe("Binance");
  });
});

describe("fetchEnrichedAddress", () => {
  it("returns null on 404", async () => {
    const f = mockFetch([{ status: 404 }]);
    const r = await fetchEnrichedAddress("0xabc", "celo", "key", f);
    expect(r).toBeNull();
  });

  it("throws ArkhamAuthError on 401", async () => {
    const f = mockFetch([{ status: 401 }]);
    await expect(
      fetchEnrichedAddress("0xabc", "celo", "key", f),
    ).rejects.toBeInstanceOf(ArkhamAuthError);
  });

  it("throws ArkhamRateLimitedError on 429", async () => {
    const f = mockFetch([{ status: 429 }]);
    await expect(
      fetchEnrichedAddress("0xabc", "celo", "key", f),
    ).rejects.toBeInstanceOf(ArkhamRateLimitedError);
  });

  it("lowercases the address in the URL", async () => {
    const captured: string[] = [];
    const f = mockFetch([
      (url) => {
        captured.push(url);
        return new Response(JSON.stringify(makeArkhamResponse()), {
          status: 200,
        }) as Response & { ok: boolean };
      },
    ]);
    await fetchEnrichedAddress("0xABCdef", "celo", "key", f);
    expect(captured[0]).toContain("/0xabcdef");
    expect(captured[0]).not.toContain("ABCdef");
  });

  it("sends API-Key header", async () => {
    let headerSeen: string | null = null;
    const f = mockFetch([
      (_url, init) => {
        const h = init.headers as Record<string, string>;
        headerSeen = h["API-Key"] ?? null;
        return new Response(JSON.stringify(makeArkhamResponse()), {
          status: 200,
        }) as Response & { ok: boolean };
      },
    ]);
    await fetchEnrichedAddress("0xabc", "celo", "secret-key", f);
    expect(headerSeen).toBe("secret-key");
  });
});

describe("fetchHealth", () => {
  it("returns true on 200", async () => {
    const f = mockFetch([{ status: 200 }]);
    expect(await fetchHealth("k", f)).toBe(true);
  });

  it("throws on 401", async () => {
    const f = mockFetch([{ status: 401 }]);
    await expect(fetchHealth("k", f)).rejects.toBeInstanceOf(ArkhamAuthError);
  });
});

describe("filterCandidates", () => {
  const manualEntry: AddressEntry = {
    name: "Treasury",
    tags: ["mento", "core"],
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const arkhamEntry: AddressEntry = {
    name: "Binance",
    tags: [ARKHAM_TAG, "exchange"],
    updatedAt: "2026-04-01T00:00:00Z",
  };

  it("returns unlabeled addresses", () => {
    expect(
      filterCandidates(["0xnew"], { "0xother": manualEntry }, "new"),
    ).toEqual(["0xnew"]);
  });

  it("never overwrites manual labels", () => {
    expect(
      filterCandidates(["0xmanual"], { "0xmanual": manualEntry }, "new"),
    ).toEqual([]);
    expect(
      filterCandidates(["0xmanual"], { "0xmanual": manualEntry }, "refresh"),
    ).toEqual([]);
  });

  it("re-enriches arkham-tagged entries only in refresh mode", () => {
    expect(
      filterCandidates(["0xark"], { "0xark": arkhamEntry }, "new"),
    ).toEqual([]);
    expect(
      filterCandidates(["0xark"], { "0xark": arkhamEntry }, "refresh"),
    ).toEqual(["0xark"]);
  });

  it("lowercases candidate addresses", () => {
    expect(filterCandidates(["0xABC"], {}, "new")).toEqual(["0xabc"]);
  });
});

describe("enrichBatch", () => {
  it("paces requests using the provided sleeper, skipping after the last", async () => {
    const sleeper = vi.fn().mockResolvedValue(undefined);
    const f = mockFetch([
      { status: 200, body: makeArkhamResponse() },
      { status: 200, body: makeArkhamResponse() },
      { status: 200, body: makeArkhamResponse() },
    ]);
    await enrichBatch(["0x1", "0x2", "0x3"], {
      apiKey: "k",
      chain: "celo",
      fetchImpl: f,
      sleeper,
    });
    // Spacing applied between iterations only (n - 1 sleeps).
    expect(sleeper).toHaveBeenCalledTimes(2);
  });

  it("retries once on 429 then surfaces the result", async () => {
    const sleeper = vi.fn().mockResolvedValue(undefined);
    const f = mockFetch([
      { status: 429 },
      {
        status: 200,
        body: makeArkhamResponse({
          arkhamLabel: { name: "X", address: "0x1", chainType: "evm" },
        }),
      },
    ]);
    const results = await enrichBatch(["0x1"], {
      apiKey: "k",
      chain: "celo",
      fetchImpl: f,
      sleeper,
    });
    expect(results[0]?.entry?.name).toBe("X");
    expect(sleeper).toHaveBeenCalledWith(RATE_LIMIT_BACKOFF_MS);
  });

  it("captures errors without aborting the batch", async () => {
    const sleeper = vi.fn().mockResolvedValue(undefined);
    const f = mockFetch([
      { status: 500 },
      { status: 200, body: makeArkhamResponse() },
    ]);
    const results = await enrichBatch(["0x1", "0x2"], {
      apiKey: "k",
      chain: "celo",
      fetchImpl: f,
      sleeper,
    });
    expect(results).toHaveLength(2);
    expect(results[0]?.error).toBeDefined();
    expect(results[1]?.error).toBeUndefined();
  });

  it("aborts on auth errors", async () => {
    const sleeper = vi.fn().mockResolvedValue(undefined);
    const f = mockFetch([{ status: 401 }]);
    await expect(
      enrichBatch(["0x1", "0x2"], {
        apiKey: "k",
        chain: "celo",
        fetchImpl: f,
        sleeper,
      }),
    ).rejects.toBeInstanceOf(ArkhamAuthError);
  });

  it("re-throws ArkhamAuthError surfaced during 429 retry", async () => {
    // Key rotated mid-batch: first call 429s, retry returns 401. Auth errors
    // are always fatal — must abort the whole batch, not be recorded as a
    // per-address error.
    const sleeper = vi.fn().mockResolvedValue(undefined);
    const f = mockFetch([{ status: 429 }, { status: 401 }]);
    await expect(
      enrichBatch(["0x1"], {
        apiKey: "k",
        chain: "celo",
        fetchImpl: f,
        sleeper,
      }),
    ).rejects.toBeInstanceOf(ArkhamAuthError);
  });
});

describe("mergeRefreshEntry", () => {
  const fresh: AddressEntry = {
    name: "Binance Hot Wallet 14",
    tags: [ARKHAM_TAG, "exchange"],
    isPublic: false,
    updatedAt: "2026-04-28T00:00:00Z",
  };

  it("returns fresh unchanged when no existing entry", () => {
    expect(mergeRefreshEntry(undefined, fresh)).toEqual(fresh);
  });

  it("returns fresh unchanged when existing has no arkham tag", () => {
    const manual: AddressEntry = {
      name: "Treasury",
      tags: ["mento"],
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(mergeRefreshEntry(manual, fresh)).toEqual(fresh);
  });

  it("preserves user-edited notes and isPublic across refresh", () => {
    const existing: AddressEntry = {
      name: "Binance",
      tags: [ARKHAM_TAG, "exchange", "user-curated"],
      notes: "this address routes the bridge fees",
      isPublic: true,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const merged = mergeRefreshEntry(existing, fresh);
    expect(merged.name).toBe("Binance Hot Wallet 14"); // Arkham wins on name
    expect(merged.notes).toBe("this address routes the bridge fees");
    expect(merged.isPublic).toBe(true);
    expect(merged.tags).toContain("user-curated");
    expect(merged.tags).toContain("exchange");
    expect(merged.tags).toContain(ARKHAM_TAG);
  });

  it("replaces auto-generated prediction notes with the new prediction", () => {
    const existing: AddressEntry = {
      name: "binance",
      tags: [ARKHAM_TAG],
      notes: "Arkham prediction (87% confidence)",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const freshWithNote: AddressEntry = {
      ...fresh,
      notes: "Arkham prediction (94% confidence)",
    };
    const merged = mergeRefreshEntry(existing, freshWithNote);
    expect(merged.notes).toBe("Arkham prediction (94% confidence)");
  });
});
