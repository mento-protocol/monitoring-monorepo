import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/cron-auth", () => ({
  requireCronAuth: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/address-labels", () => ({
  getLabel: vi.fn(),
  getLabels: vi.fn(),
  importArkhamRefreshLabelsIfUnchanged: vi.fn().mockResolvedValue(1),
  importLabelsIfAbsent: vi.fn().mockResolvedValue(1),
}));

vi.mock("@/lib/arkham", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/arkham")>("@/lib/arkham");
  return {
    ...actual,
    fetchHealth: vi.fn().mockResolvedValue(true),
    enrichBatch: vi.fn(),
    // keep filterCandidates real so the route's filtering logic exercises it
  };
});

vi.mock("@/lib/mento-address-discovery", () => ({
  discoverMentoAddresses: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  withMonitor: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import { GET } from "../enrich/route";
import type { AddressEntry } from "@/lib/address-labels-shared";
import {
  getLabel,
  getLabels,
  importArkhamRefreshLabelsIfUnchanged,
  importLabelsIfAbsent,
} from "@/lib/address-labels";
import { ARKHAM_TAG } from "@/lib/address-labels-shared";
import { ArkhamAuthError, enrichBatch, fetchHealth } from "@/lib/arkham";
import { discoverMentoAddresses } from "@/lib/mento-address-discovery";
import { requireCronAuth } from "@/lib/cron-auth";
import * as Sentry from "@sentry/nextjs";

const mockGetLabels = vi.mocked(getLabels);
const mockGetLabel = vi.mocked(getLabel);
const mockImportArkhamRefreshLabelsIfUnchanged = vi.mocked(
  importArkhamRefreshLabelsIfUnchanged,
);
const mockImportLabelsIfAbsent = vi.mocked(importLabelsIfAbsent);
const mockFetchHealth = vi.mocked(fetchHealth);
const mockEnrichBatch = vi.mocked(enrichBatch);
const mockDiscover = vi.mocked(discoverMentoAddresses);
const mockRequireCronAuth = vi.mocked(requireCronAuth);
const mockCaptureMessage = vi.mocked(Sentry.captureMessage);

let currentLabels: Record<string, AddressEntry>;

function emptyLabels(): Record<string, AddressEntry> {
  currentLabels = {};
  return currentLabels;
}
function existingLabels(
  entries: Record<string, AddressEntry>,
): Record<string, AddressEntry> {
  currentLabels = entries;
  return entries;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("ARKHAM_API_KEY", "ak-test");
  vi.stubEnv("NEXT_PUBLIC_HASURA_URL", "https://hasura.test/graphql");
  vi.stubEnv("NODE_ENV", "production");
  // Default to a healthy reachability probe; tests that need to fail it
  // override per-case.
  mockRequireCronAuth.mockResolvedValue(null);
  mockFetchHealth.mockResolvedValue(true);
  currentLabels = {};
  mockGetLabel.mockImplementation(
    async (address) => currentLabels[address.toLowerCase()] ?? null,
  );
});

function makeReq(
  opts: {
    bearer?: string;
    searchParams?: Record<string, string>;
  } = {},
): NextRequest {
  const url = new URL("http://localhost/api/arkham/enrich");
  for (const [k, v] of Object.entries(opts.searchParams ?? {})) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url, {
    method: "GET",
    headers: opts.bearer
      ? { authorization: `Bearer ${opts.bearer}` }
      : undefined,
  });
}

describe("GET /api/arkham/enrich — auth", () => {
  it("returns the cron auth failure before touching expensive dependencies", async () => {
    mockRequireCronAuth.mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const req = makeReq();
    const res = await GET(req);

    expect(res.status).toBe(401);
    expect(mockRequireCronAuth).toHaveBeenCalledWith(req, "arkham/enrich");
    expect(mockFetchHealth).not.toHaveBeenCalled();
    expect(mockDiscover).not.toHaveBeenCalled();
    expect(mockGetLabels).not.toHaveBeenCalled();
    expect(mockEnrichBatch).not.toHaveBeenCalled();
    expect(mockImportLabelsIfAbsent).not.toHaveBeenCalled();
    expect(mockImportArkhamRefreshLabelsIfUnchanged).not.toHaveBeenCalled();
  });

  it("runs when cron auth passes", async () => {
    mockDiscover.mockResolvedValue({ addresses: [], perEntity: [] });
    mockGetLabels.mockResolvedValue(emptyLabels());
    mockEnrichBatch.mockResolvedValue([]);

    const req = makeReq({ bearer: "cron-secret" });
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(mockRequireCronAuth).toHaveBeenCalledWith(req, "arkham/enrich");
  });
});

describe("GET /api/arkham/enrich — config", () => {
  it("500s when ARKHAM_API_KEY is missing", async () => {
    vi.stubEnv("ARKHAM_API_KEY", "");
    const res = await GET(makeReq({ bearer: "cron-secret" }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/ARKHAM_API_KEY/);
  });

  it("500s when NEXT_PUBLIC_HASURA_URL is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_HASURA_URL", "");
    const res = await GET(makeReq({ bearer: "cron-secret" }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/HASURA/);
  });

  it("502s on auth error from Arkham", async () => {
    mockFetchHealth.mockRejectedValueOnce(new ArkhamAuthError());
    mockDiscover.mockResolvedValue({ addresses: [], perEntity: [] });
    mockGetLabels.mockResolvedValue(emptyLabels());
    const res = await GET(makeReq({ bearer: "cron-secret" }));
    expect(res.status).toBe(502);
  });
});

describe("GET /api/arkham/enrich — pipeline", () => {
  it("filters candidates against existing manual labels", async () => {
    mockDiscover.mockResolvedValue({
      addresses: ["0xnew", "0xmanual", "0xark"],
      perEntity: [{ table: "SwapEvent", field: "sender", count: 3 }],
    });
    mockGetLabels.mockResolvedValue(
      existingLabels({
        "0xmanual": {
          name: "Treasury",
          tags: ["mento"],
          updatedAt: "2026-01-01T00:00:00Z",
        },
        "0xark": {
          name: "Binance",
          tags: [ARKHAM_TAG, "exchange"],
          updatedAt: "2026-04-01T00:00:00Z",
        },
      }),
    );
    mockEnrichBatch.mockResolvedValue([
      {
        address: "0xnew",
        entry: {
          name: "Coinbase",
          tags: ["exchange"],
          source: "arkham",
          updatedAt: "2026-04-28T00:00:00Z",
        },
      },
    ]);

    const res = await GET(
      makeReq({
        bearer: "cron-secret",
        searchParams: { mode: "bogus" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.mode).toBe("new"); // unknown modes fall back to one-shot backfill
    expect(body.discovered).toBe(3);
    expect(body.candidates).toBe(1); // only 0xnew passes the filter
    expect(body.enriched).toBe(1);

    expect(mockEnrichBatch).toHaveBeenCalledWith(
      ["0xnew"],
      expect.objectContaining({ apiKey: "ak-test" }),
    );
    expect(mockImportLabelsIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        "0xnew": expect.objectContaining({
          name: "Coinbase",
          source: "arkham",
        }),
      }),
    );
  });

  it("refresh mode re-enriches legacy ARKHAM_TAG entries", async () => {
    // Backward-compat: pre-source-field entries carry provenance via the
    // sentinel tag. Filter must still pick them up; merge upgrades them.
    mockDiscover.mockResolvedValue({
      addresses: ["0xark"],
      perEntity: [],
    });
    mockGetLabels.mockResolvedValue(
      existingLabels({
        "0xark": {
          name: "Binance",
          tags: [ARKHAM_TAG, "user-curated"],
          notes: "user note about this address",
          isPublic: true,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      }),
    );
    mockEnrichBatch.mockResolvedValue([
      {
        address: "0xark",
        entry: {
          name: "Binance Hot Wallet 14",
          tags: ["exchange"],
          source: "arkham",
          updatedAt: "2026-04-28T00:00:00Z",
        },
      },
    ]);

    const res = await GET(
      makeReq({ bearer: "cron-secret", searchParams: { mode: "refresh" } }),
    );
    expect(res.status).toBe(200);
    expect(mockEnrichBatch).toHaveBeenCalledWith(["0xark"], expect.anything());

    // mergeRefreshEntry: name takes Arkham's update; user notes + isPublic
    // survive; sentinel tag stripped; source upgraded.
    expect(mockImportArkhamRefreshLabelsIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({
        "0xark": expect.objectContaining({
          name: "Binance Hot Wallet 14",
          notes: "user note about this address",
          isPublic: true,
          source: "arkham",
          tags: expect.arrayContaining(["exchange", "user-curated"]),
        }),
      }),
      { "0xark": "2026-01-01T00:00:00Z" },
    );
  });

  it("refresh mode re-enriches source-tagged entries", async () => {
    mockDiscover.mockResolvedValue({
      addresses: ["0xark"],
      perEntity: [],
    });
    mockGetLabels.mockResolvedValue(
      existingLabels({
        "0xark": {
          name: "Binance",
          tags: ["exchange"],
          source: "arkham",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      }),
    );
    mockEnrichBatch.mockResolvedValue([
      {
        address: "0xark",
        entry: {
          name: "Binance Hot Wallet 14",
          tags: ["exchange"],
          source: "arkham",
          updatedAt: "2026-04-28T00:00:00Z",
        },
      },
    ]);

    const res = await GET(
      makeReq({ bearer: "cron-secret", searchParams: { mode: "refresh" } }),
    );
    expect(res.status).toBe(200);
    expect(mockEnrichBatch).toHaveBeenCalledWith(["0xark"], expect.anything());
    expect(mockImportArkhamRefreshLabelsIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({
        "0xark": expect.objectContaining({
          name: "Binance Hot Wallet 14",
          source: "arkham",
        }),
      }),
      { "0xark": "2026-01-01T00:00:00Z" },
    );
  });

  it("refresh mode preserves user edits saved after the initial label snapshot", async () => {
    mockDiscover.mockResolvedValue({
      addresses: ["0xark"],
      perEntity: [],
    });
    mockGetLabels.mockResolvedValue(
      existingLabels({
        "0xark": {
          name: "Binance",
          tags: ["exchange"],
          notes: "old note",
          isPublic: false,
          source: "arkham",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      }),
    );
    mockEnrichBatch.mockImplementation(async () => {
      currentLabels["0xark"] = {
        ...currentLabels["0xark"],
        notes: "edited during refresh",
        tags: ["exchange", "user-curated"],
        isPublic: true,
        updatedAt: "2026-04-27T00:00:00Z",
      };
      return [
        {
          address: "0xark",
          entry: {
            name: "Binance Hot Wallet 14",
            tags: ["exchange"],
            source: "arkham",
            updatedAt: "2026-04-28T00:00:00Z",
          },
        },
      ];
    });

    const res = await GET(
      makeReq({ bearer: "cron-secret", searchParams: { mode: "refresh" } }),
    );
    expect(res.status).toBe(200);
    expect(mockImportArkhamRefreshLabelsIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({
        "0xark": expect.objectContaining({
          name: "Binance Hot Wallet 14",
          notes: "edited during refresh",
          isPublic: true,
          tags: expect.arrayContaining(["exchange", "user-curated"]),
        }),
      }),
      { "0xark": "2026-04-27T00:00:00Z" },
    );
  });

  it("refresh mode skips a label changed after the late read instead of overwriting it", async () => {
    mockDiscover.mockResolvedValue({
      addresses: ["0xark"],
      perEntity: [],
    });
    mockGetLabels.mockResolvedValue(
      existingLabels({
        "0xark": {
          name: "Binance",
          tags: ["exchange"],
          source: "arkham",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      }),
    );
    mockEnrichBatch.mockResolvedValue([
      {
        address: "0xark",
        entry: {
          name: "Binance Hot Wallet 14",
          tags: ["exchange"],
          source: "arkham",
          updatedAt: "2026-04-28T00:00:00Z",
        },
      },
    ]);
    mockImportArkhamRefreshLabelsIfUnchanged.mockResolvedValueOnce(0);

    const res = await GET(
      makeReq({ bearer: "cron-secret", searchParams: { mode: "refresh" } }),
    );

    expect(res.status).toBe(200);
    expect(mockImportArkhamRefreshLabelsIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({
        "0xark": expect.objectContaining({
          name: "Binance Hot Wallet 14",
        }),
      }),
      { "0xark": "2026-01-01T00:00:00Z" },
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.enriched).toBe(0);
    expect(body.skipped).toBe(1);
  });

  it("new mode skips an address that becomes manually labeled during enrichment", async () => {
    mockDiscover.mockResolvedValue({
      addresses: ["0xnew"],
      perEntity: [],
    });
    mockGetLabels.mockResolvedValue(emptyLabels());
    mockEnrichBatch.mockImplementation(async () => {
      currentLabels["0xnew"] = {
        name: "Manual label",
        tags: ["mento"],
        updatedAt: "2026-04-27T00:00:00Z",
      };
      return [
        {
          address: "0xnew",
          entry: {
            name: "Coinbase",
            tags: ["exchange"],
            source: "arkham",
            updatedAt: "2026-04-28T00:00:00Z",
          },
        },
      ];
    });

    const res = await GET(makeReq({ bearer: "cron-secret" }));
    expect(res.status).toBe(200);
    expect(mockImportLabelsIfAbsent).not.toHaveBeenCalled();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.enriched).toBe(0);
    expect(body.skipped).toBe(1);
  });

  it("refresh mode rotates oldest Arkham-sourced entries first", async () => {
    mockDiscover.mockResolvedValue({
      addresses: ["0xnewer", "0xoldest", "0xmiddle"],
      perEntity: [],
    });
    mockGetLabels.mockResolvedValue(
      existingLabels({
        // Mix legacy ARKHAM_TAG labels with source-tagged entries so refresh
        // rotation keeps covering both Arkham-attribution formats.
        "0xnewer": {
          name: "Newer",
          tags: ["arkham"],
          source: "arkham",
          updatedAt: "2026-04-01T00:00:00Z",
        },
        "0xoldest": {
          name: "Oldest",
          tags: [ARKHAM_TAG],
          updatedAt: "2026-01-01T00:00:00Z",
        },
        "0xmiddle": {
          name: "Middle",
          tags: ["exchange"],
          source: "arkham",
          updatedAt: "2026-02-01T00:00:00Z",
        },
      }),
    );
    mockEnrichBatch.mockResolvedValue([]);

    await GET(
      makeReq({
        bearer: "cron-secret",
        searchParams: { mode: "refresh", limit: "2" },
      }),
    );

    expect(mockEnrichBatch).toHaveBeenCalledWith(
      ["0xoldest", "0xmiddle"],
      expect.anything(),
    );
  });

  it("dryRun mode skips Redis writes", async () => {
    mockDiscover.mockResolvedValue({
      addresses: ["0xnew"],
      perEntity: [],
    });
    mockGetLabels.mockResolvedValue(emptyLabels());
    mockEnrichBatch.mockResolvedValue([
      {
        address: "0xnew",
        entry: {
          name: "X",
          tags: [],
          source: "arkham",
          updatedAt: "2026-04-28T00:00:00Z",
        },
      },
    ]);

    const res = await GET(
      makeReq({ bearer: "cron-secret", searchParams: { mode: "dryRun" } }),
    );
    expect(res.status).toBe(200);
    expect(mockImportLabelsIfAbsent).not.toHaveBeenCalled();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.mode).toBe("dryRun");
    expect(body.enriched).toBe(1);
    expect(body.errors).toBe(0);
  });

  it("respects the limit query param", async () => {
    mockDiscover.mockResolvedValue({
      addresses: ["0xa", "0xb", "0xc", "0xd"],
      perEntity: [],
    });
    mockGetLabels.mockResolvedValue(emptyLabels());
    mockEnrichBatch.mockResolvedValue([]);

    await GET(makeReq({ bearer: "cron-secret", searchParams: { limit: "2" } }));
    expect(mockEnrichBatch).toHaveBeenCalledWith(
      ["0xa", "0xb"],
      expect.anything(),
    );
  });

  it("filters out manually-labeled addresses from `mode=new`", async () => {
    // mode=new only enriches addresses with no existing label. A manual label
    // for `0xguardian` must keep it out of the candidate set even though
    // Arkham would attribute it.
    mockDiscover.mockResolvedValue({
      addresses: ["0xguardian"],
      perEntity: [],
    });
    mockGetLabels.mockResolvedValue({
      "0xguardian": {
        name: "Mento Guardian",
        tags: ["mento", "core"],
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    mockEnrichBatch.mockResolvedValue([]);

    await GET(makeReq({ bearer: "cron-secret" }));
    expect(mockEnrichBatch).toHaveBeenCalledWith([], expect.anything());
    expect(mockImportLabelsIfAbsent).not.toHaveBeenCalled();
  });

  it("?limit=0 falls back to the default cap (no silent no-op)", async () => {
    mockDiscover.mockResolvedValue({
      addresses: ["0xa", "0xb", "0xc"],
      perEntity: [],
    });
    mockGetLabels.mockResolvedValue(emptyLabels());
    mockEnrichBatch.mockResolvedValue([]);

    await GET(makeReq({ bearer: "cron-secret", searchParams: { limit: "0" } }));
    // All 3 addresses passed through, not zero — `?limit=0` must not silently
    // skip enrichment.
    expect(mockEnrichBatch).toHaveBeenCalledWith(
      ["0xa", "0xb", "0xc"],
      expect.anything(),
    );
  });

  it("captures partial errors without failing the run", async () => {
    mockDiscover.mockResolvedValue({
      addresses: ["0xa", "0xb"],
      perEntity: [],
    });
    mockGetLabels.mockResolvedValue(emptyLabels());
    mockEnrichBatch.mockResolvedValue([
      { address: "0xa", entry: null, error: "5xx" },
      {
        address: "0xb",
        entry: {
          name: "X",
          tags: [],
          source: "arkham",
          updatedAt: "2026-04-28T00:00:00Z",
        },
      },
    ]);

    const res = await GET(makeReq({ bearer: "cron-secret" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.errors).toBe(1);
    expect(body.enriched).toBe(1);
    expect(body.skipped).toBe(0);
    expect(body.sampleErrors).toEqual(["0xa: 5xx"]);
    expect(mockImportLabelsIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        "0xb": expect.objectContaining({ source: "arkham" }),
      }),
    );
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "[arkham/enrich] 1 errors during batch",
      expect.objectContaining({
        tags: { route: "arkham/enrich", mode: "new" },
        level: "warning",
      }),
    );
  });

  it("reports getLabel failures per address without failing the run", async () => {
    mockDiscover.mockResolvedValue({
      addresses: ["0xa", "0xb"],
      perEntity: [],
    });
    mockGetLabels.mockResolvedValue(emptyLabels());
    mockEnrichBatch.mockResolvedValue([
      {
        address: "0xa",
        entry: {
          name: "A",
          tags: [],
          source: "arkham",
          updatedAt: "2026-04-28T00:00:00Z",
        },
      },
      {
        address: "0xb",
        entry: {
          name: "B",
          tags: [],
          source: "arkham",
          updatedAt: "2026-04-28T00:00:00Z",
        },
      },
    ]);
    mockGetLabel.mockImplementation(async (address) => {
      if (address === "0xa") throw new Error("redis read failed");
      return null;
    });

    const res = await GET(makeReq({ bearer: "cron-secret" }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.errors).toBe(1);
    expect(body.enriched).toBe(1);
    expect(body.skipped).toBe(0);
    expect(body.sampleErrors).toEqual([
      "0xa: getLabel failed: redis read failed",
    ]);
    expect(mockImportLabelsIfAbsent).toHaveBeenCalledWith({
      "0xb": expect.objectContaining({ name: "B", source: "arkham" }),
    });
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "[arkham/enrich] 1 errors during batch",
      expect.objectContaining({
        tags: { route: "arkham/enrich", mode: "new" },
        level: "warning",
      }),
    );
  });

  it("bounds late getLabel reads while building the write set", async () => {
    const addresses = Array.from({ length: 33 }, (_, index) => `0x${index}`);
    mockDiscover.mockResolvedValue({
      addresses,
      perEntity: [],
    });
    mockGetLabels.mockResolvedValue(emptyLabels());
    mockEnrichBatch.mockResolvedValue(
      addresses.map((address) => ({
        address,
        entry: {
          name: address,
          tags: [],
          source: "arkham",
          updatedAt: "2026-04-28T00:00:00Z",
        },
      })),
    );

    let inFlight = 0;
    let maxInFlight = 0;
    mockGetLabel.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return null;
    });

    const res = await GET(makeReq({ bearer: "cron-secret" }));

    expect(res.status).toBe(200);
    expect(mockGetLabel).toHaveBeenCalledTimes(addresses.length);
    expect(maxInFlight).toBeLessThan(addresses.length);
    expect(maxInFlight).toBeLessThanOrEqual(16);
  });
});
