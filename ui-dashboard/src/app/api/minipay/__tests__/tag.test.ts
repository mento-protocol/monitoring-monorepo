import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/address-labels", () => ({
  getAllLabels: vi.fn(),
  importLabels: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/arkham-discovery", () => ({
  discoverMentoAddresses: vi.fn(),
}));

vi.mock("@/lib/minipay", () => ({
  intersectMiniPay: vi.fn(),
  getMiniPaySetSize: vi.fn(),
  toMiniPayEntry: vi.fn(() => ({
    name: "",
    tags: ["MiniPay User"],
    source: "minipay",
    isPublic: false,
    updatedAt: "2026-04-30T00:00:00.000Z",
  })),
}));

vi.mock("@sentry/nextjs", () => ({
  withMonitor: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
  captureException: vi.fn(),
}));

import { GET } from "../tag/route";
import { getAllLabels, importLabels } from "@/lib/address-labels";
import { discoverMentoAddresses } from "@/lib/arkham-discovery";
import { intersectMiniPay, getMiniPaySetSize } from "@/lib/minipay";

const mockGetAllLabels = vi.mocked(getAllLabels);
const mockImportLabels = vi.mocked(importLabels);
const mockDiscover = vi.mocked(discoverMentoAddresses);
const mockIntersect = vi.mocked(intersectMiniPay);
const mockSetSize = vi.mocked(getMiniPaySetSize);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("NEXT_PUBLIC_HASURA_URL", "https://hasura.test/graphql");
  vi.stubEnv("NODE_ENV", "production");
  mockSetSize.mockResolvedValue(1_000_000);
});

function makeReq(
  opts: {
    bearer?: string;
    searchParams?: Record<string, string>;
  } = {},
): NextRequest {
  const url = new URL("http://localhost/api/minipay/tag");
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

describe("GET /api/minipay/tag — auth", () => {
  it("401s without bearer", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });
});

describe("GET /api/minipay/tag — filtering", () => {
  it("drops addresses with any existing label (Arkham, manual, anything)", async () => {
    mockDiscover.mockResolvedValue({
      addresses: ["0xa", "0xb", "0xc"],
      perEntity: [],
    });
    mockGetAllLabels.mockResolvedValue({
      global: {
        // 0xa has an Arkham label — must NOT be re-tagged
        "0xa": {
          name: "Binance",
          tags: [],
          source: "arkham",
          updatedAt: "2026-01-01",
        },
        // 0xb has a manual label — must NOT be re-tagged
        "0xb": { name: "Treasury", tags: [], updatedAt: "2026-01-01" },
      },
      chains: {},
    });
    // Only 0xc is a candidate; intersect returns it as a MiniPay user
    mockIntersect.mockResolvedValue(["0xc"]);

    const res = await GET(makeReq({ bearer: "cron-secret" }));
    expect(res.status).toBe(200);

    // intersect should be called with only 0xc — others were filtered out
    expect(mockIntersect).toHaveBeenCalledWith(["0xc"]);

    // import should write only 0xc, with source=minipay; crossScopeHdel
    // is opted out because the candidate filter already established that
    // 0xc has no entry in any scope.
    expect(mockImportLabels).toHaveBeenCalledWith(
      "global",
      { "0xc": expect.objectContaining({ source: "minipay" }) },
      { crossScopeHdel: false },
    );
  });

  it("dryRun returns the would-write addresses without persisting", async () => {
    mockDiscover.mockResolvedValue({
      addresses: ["0xa", "0xb", "0xc"],
      perEntity: [],
    });
    mockGetAllLabels.mockResolvedValue({ global: {}, chains: {} });
    mockIntersect.mockResolvedValue(["0xa", "0xc"]);

    const res = await GET(
      makeReq({ bearer: "cron-secret", searchParams: { mode: "dryRun" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      matched: number;
      written: number;
      wouldWrite?: string[];
    };
    expect(body.mode).toBe("dryRun");
    expect(body.matched).toBe(2);
    expect(body.written).toBe(0);
    // Documented spot-check flow: dryRun must surface the actual address
    // list so reviewers can verify a few against Celoscan.
    expect(body.wouldWrite).toEqual(["0xa", "0xc"]);
    expect(mockImportLabels).not.toHaveBeenCalled();
  });

  it("non-dryRun does not include wouldWrite (keeps payload small)", async () => {
    mockDiscover.mockResolvedValue({ addresses: ["0xa"], perEntity: [] });
    mockGetAllLabels.mockResolvedValue({ global: {}, chains: {} });
    mockIntersect.mockResolvedValue(["0xa"]);

    const res = await GET(makeReq({ bearer: "cron-secret" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { wouldWrite?: string[] };
    expect(body.wouldWrite).toBeUndefined();
  });

  it("returns clean no-op when MiniPay set is empty AND skips expensive upstream fetches", async () => {
    mockSetSize.mockResolvedValue(0);

    const res = await GET(makeReq({ bearer: "cron-secret" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      matched: number;
      written: number;
      minipaySetSize: number;
      discovered: number;
    };
    expect(body.matched).toBe(0);
    expect(body.written).toBe(0);
    expect(body.minipaySetSize).toBe(0);
    expect(body.discovered).toBe(0);
    // Hot path: skip Hasura + Redis SCAN + intersect when the set is empty.
    expect(mockDiscover).not.toHaveBeenCalled();
    expect(mockGetAllLabels).not.toHaveBeenCalled();
    expect(mockIntersect).not.toHaveBeenCalled();
    expect(mockImportLabels).not.toHaveBeenCalled();
  });
});
