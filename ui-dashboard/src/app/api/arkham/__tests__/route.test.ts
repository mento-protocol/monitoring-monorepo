import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/auth", () => ({
  getAuthSession: vi.fn(),
}));

vi.mock("@/lib/address-labels", () => ({
  getAllLabels: vi.fn(),
  importLabels: vi.fn().mockResolvedValue(undefined),
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

vi.mock("@/lib/arkham-discovery", () => ({
  discoverMentoAddresses: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  withMonitor: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import { GET } from "../enrich/route";
import type { AddressEntry } from "@/lib/address-labels-shared";
import { getAuthSession } from "@/auth";
import { getAllLabels, importLabels } from "@/lib/address-labels";
import {
  ARKHAM_TAG,
  ArkhamAuthError,
  enrichBatch,
  fetchHealth,
} from "@/lib/arkham";
import { discoverMentoAddresses } from "@/lib/arkham-discovery";

const mockGetAuthSession = vi.mocked(getAuthSession);
const mockGetAllLabels = vi.mocked(getAllLabels);
const mockImportLabels = vi.mocked(importLabels);
const mockFetchHealth = vi.mocked(fetchHealth);
const mockEnrichBatch = vi.mocked(enrichBatch);
const mockDiscover = vi.mocked(discoverMentoAddresses);

function emptyLabels() {
  return { global: {}, chains: {} };
}
function celoLabels(entries: Record<string, AddressEntry>) {
  return { global: {}, chains: { "42220": entries } };
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
  mockFetchHealth.mockResolvedValue(true);
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
  it("401s when no auth and no session", async () => {
    mockGetAuthSession.mockResolvedValue(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it("accepts Bearer CRON_SECRET", async () => {
    mockDiscover.mockResolvedValue({ addresses: [], perEntity: [] });
    mockGetAllLabels.mockResolvedValue(emptyLabels());
    mockEnrichBatch.mockResolvedValue([]);

    const res = await GET(makeReq({ bearer: "cron-secret" }));
    expect(res.status).toBe(200);
  });

  it("rejects wrong Bearer", async () => {
    mockGetAuthSession.mockResolvedValue(null);
    const res = await GET(makeReq({ bearer: "wrong" }));
    expect(res.status).toBe(401);
  });

  it("401s on session-only auth — bearer required for cron GET (CSRF defence)", async () => {
    mockGetAuthSession.mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
      expires: "2099-01-01T00:00:00Z",
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it("500s when CRON_SECRET is unset", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const res = await GET(makeReq({ bearer: "anything" }));
    expect(res.status).toBe(500);
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
    mockGetAllLabels.mockResolvedValue(emptyLabels());
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
    mockGetAllLabels.mockResolvedValue(
      celoLabels({
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
          tags: [ARKHAM_TAG, "exchange"],
          updatedAt: "2026-04-28T00:00:00Z",
        },
      },
    ]);

    const res = await GET(makeReq({ bearer: "cron-secret" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.discovered).toBe(3);
    expect(body.candidates).toBe(1); // only 0xnew passes the filter
    expect(body.enriched).toBe(1);

    expect(mockEnrichBatch).toHaveBeenCalledWith(
      ["0xnew"],
      expect.objectContaining({ apiKey: "ak-test" }),
    );
    expect(mockImportLabels).toHaveBeenCalledWith(
      42220,
      expect.objectContaining({
        "0xnew": expect.objectContaining({ name: "Coinbase" }),
      }),
    );
  });

  it("refresh mode re-enriches arkham-tagged entries", async () => {
    mockDiscover.mockResolvedValue({
      addresses: ["0xark"],
      perEntity: [],
    });
    mockGetAllLabels.mockResolvedValue(
      celoLabels({
        "0xark": {
          name: "Binance",
          tags: [ARKHAM_TAG],
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
          tags: [ARKHAM_TAG, "exchange"],
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
    // survive; tags union.
    expect(mockImportLabels).toHaveBeenCalledWith(
      42220,
      expect.objectContaining({
        "0xark": expect.objectContaining({
          name: "Binance Hot Wallet 14",
          notes: "user note about this address",
          isPublic: true,
        }),
      }),
    );
  });

  it("dryRun mode skips Redis writes", async () => {
    mockDiscover.mockResolvedValue({
      addresses: ["0xnew"],
      perEntity: [],
    });
    mockGetAllLabels.mockResolvedValue(emptyLabels());
    mockEnrichBatch.mockResolvedValue([
      {
        address: "0xnew",
        entry: {
          name: "X",
          tags: [ARKHAM_TAG],
          updatedAt: "2026-04-28T00:00:00Z",
        },
      },
    ]);

    const res = await GET(
      makeReq({ bearer: "cron-secret", searchParams: { mode: "dryRun" } }),
    );
    expect(res.status).toBe(200);
    expect(mockImportLabels).not.toHaveBeenCalled();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.mode).toBe("dryRun");
    expect(body.enriched).toBe(1);
  });

  it("respects the limit query param", async () => {
    mockDiscover.mockResolvedValue({
      addresses: ["0xa", "0xb", "0xc", "0xd"],
      perEntity: [],
    });
    mockGetAllLabels.mockResolvedValue(emptyLabels());
    mockEnrichBatch.mockResolvedValue([]);

    await GET(makeReq({ bearer: "cron-secret", searchParams: { limit: "2" } }));
    expect(mockEnrichBatch).toHaveBeenCalledWith(
      ["0xa", "0xb"],
      expect.anything(),
    );
  });

  it("protects global-scope manual labels from being overwritten", async () => {
    // importLabels Lua HDELs the address from every other `labels:*` scope.
    // A global manual label for `0xguardian` MUST NOT show up in `toWrite`
    // even though Arkham knows it — otherwise the chain-scope write would
    // silently delete the global entry.
    mockDiscover.mockResolvedValue({
      addresses: ["0xguardian"],
      perEntity: [],
    });
    mockGetAllLabels.mockResolvedValue({
      global: {
        "0xguardian": {
          name: "Mento Guardian (cross-chain)",
          tags: ["mento", "core"],
          updatedAt: "2026-01-01T00:00:00Z",
        },
      },
      chains: {},
    });
    mockEnrichBatch.mockResolvedValue([]);

    await GET(makeReq({ bearer: "cron-secret" }));
    expect(mockEnrichBatch).toHaveBeenCalledWith([], expect.anything());
    expect(mockImportLabels).not.toHaveBeenCalled();
  });

  it("?limit=0 falls back to the default cap (no silent no-op)", async () => {
    mockDiscover.mockResolvedValue({
      addresses: ["0xa", "0xb", "0xc"],
      perEntity: [],
    });
    mockGetAllLabels.mockResolvedValue(emptyLabels());
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
    mockGetAllLabels.mockResolvedValue(emptyLabels());
    mockEnrichBatch.mockResolvedValue([
      { address: "0xa", entry: null, error: "5xx" },
      {
        address: "0xb",
        entry: {
          name: "X",
          tags: [ARKHAM_TAG],
          updatedAt: "2026-04-28T00:00:00Z",
        },
      },
    ]);

    const res = await GET(makeReq({ bearer: "cron-secret" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.errors).toBe(1);
    expect(body.enriched).toBe(1);
  });
});
