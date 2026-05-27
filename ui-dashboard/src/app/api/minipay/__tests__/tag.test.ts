import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/address-labels", () => ({
  getLabels: vi.fn(),
  importLabelsIfAbsent: vi.fn().mockResolvedValue(0),
}));

vi.mock("@/lib/mento-address-discovery", () => ({
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
import { getLabels, importLabelsIfAbsent } from "@/lib/address-labels";
import { discoverMentoAddresses } from "@/lib/mento-address-discovery";
import { intersectMiniPay, getMiniPaySetSize } from "@/lib/minipay";
import * as Sentry from "@sentry/nextjs";

const mockGetLabels = vi.mocked(getLabels);
const mockImportLabelsIfAbsent = vi.mocked(importLabelsIfAbsent);
const mockDiscover = vi.mocked(discoverMentoAddresses);
const mockIntersect = vi.mocked(intersectMiniPay);
const mockSetSize = vi.mocked(getMiniPaySetSize);
const mockWithMonitor = vi.mocked(Sentry.withMonitor);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("NEXT_PUBLIC_HASURA_URL", "https://hasura.test/graphql");
  vi.stubEnv("NODE_ENV", "production");
  mockSetSize.mockResolvedValue(1_000_000);
  mockImportLabelsIfAbsent.mockResolvedValue(0);
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
    ...(opts.bearer
      ? { headers: { authorization: `Bearer ${opts.bearer}` } }
      : {}),
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
    mockGetLabels.mockResolvedValue({
      // 0xa has an Arkham label — must NOT be re-tagged
      "0xa": {
        name: "Binance",
        tags: [],
        source: "arkham",
        updatedAt: "2026-01-01",
      },
      // 0xb has a manual label — must NOT be re-tagged
      "0xb": { name: "Treasury", tags: [], updatedAt: "2026-01-01" },
    });
    // Only 0xc is a candidate; intersect returns it as a MiniPay user
    mockIntersect.mockResolvedValue(["0xc"]);

    const res = await GET(makeReq({ bearer: "cron-secret" }));
    expect(res.status).toBe(200);

    // intersect should be called with only 0xc — others were filtered out
    expect(mockIntersect).toHaveBeenCalledWith(["0xc"]);

    // Insert-only import should write only 0xc, with source=minipay.
    expect(mockImportLabelsIfAbsent).toHaveBeenCalledWith({
      "0xc": expect.objectContaining({ source: "minipay" }),
    });
  });

  it("reports the insert-only write count to surface labels added during the scan", async () => {
    mockDiscover.mockResolvedValue({ addresses: ["0xa"], perEntity: [] });
    mockGetLabels.mockResolvedValue({});
    mockIntersect.mockResolvedValue(["0xa"]);
    mockImportLabelsIfAbsent.mockResolvedValue(0);

    const res = await GET(makeReq({ bearer: "cron-secret" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matched: number; written: number };
    expect(body.matched).toBe(1);
    expect(body.written).toBe(0);
  });

  it("dryRun returns the would-write addresses without persisting", async () => {
    mockDiscover.mockResolvedValue({
      addresses: ["0xa", "0xb", "0xc"],
      perEntity: [],
    });
    mockGetLabels.mockResolvedValue({});
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
    expect(body.wouldWrite).toEqual(["0xa", "0xc"]);
    expect(mockImportLabelsIfAbsent).not.toHaveBeenCalled();
  });

  it("non-dryRun does not include wouldWrite (keeps payload small)", async () => {
    mockDiscover.mockResolvedValue({ addresses: ["0xa"], perEntity: [] });
    mockGetLabels.mockResolvedValue({});
    mockIntersect.mockResolvedValue(["0xa"]);

    const res = await GET(makeReq({ bearer: "cron-secret" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { wouldWrite?: string[] };
    expect(body.wouldWrite).toBeUndefined();
  });

  it("keeps Sentry maxRuntime aligned with the route execution budget", async () => {
    mockDiscover.mockResolvedValue({ addresses: [], perEntity: [] });
    mockGetLabels.mockResolvedValue({});
    mockIntersect.mockResolvedValue([]);

    const res = await GET(makeReq({ bearer: "cron-secret" }));
    expect(res.status).toBe(200);
    expect(mockWithMonitor).toHaveBeenCalledWith(
      "minipay-tag",
      expect.any(Function),
      expect.objectContaining({ maxRuntime: 14 }),
    );
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
    expect(mockDiscover).not.toHaveBeenCalled();
    expect(mockGetLabels).not.toHaveBeenCalled();
    expect(mockIntersect).not.toHaveBeenCalled();
    expect(mockImportLabelsIfAbsent).not.toHaveBeenCalled();
  });
});
