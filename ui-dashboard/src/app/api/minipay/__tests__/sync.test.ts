import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/minipay", () => ({
  DuneAuthError: class DuneAuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "DuneAuthError";
    }
  },
  fetchMiniPayUsers: vi.fn(),
  addToMiniPaySet: vi.fn(),
  getMiniPaySetSize: vi.fn(),
  getLastSyncedBlock: vi.fn(),
  setLastSyncedBlock: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  withMonitor: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
  captureException: vi.fn(),
}));

import { GET } from "../sync/route";
import {
  DuneAuthError,
  addToMiniPaySet,
  fetchMiniPayUsers,
  getLastSyncedBlock,
  getMiniPaySetSize,
  setLastSyncedBlock,
} from "@/lib/minipay";

const mockFetch = vi.mocked(fetchMiniPayUsers);
const mockAdd = vi.mocked(addToMiniPaySet);
const mockSize = vi.mocked(getMiniPaySetSize);
const mockGetCursor = vi.mocked(getLastSyncedBlock);
const mockSetCursor = vi.mocked(setLastSyncedBlock);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("DUNE_API_KEY", "dune-test");
  vi.stubEnv("NODE_ENV", "production");
});

function makeReq(bearer?: string): NextRequest {
  return new NextRequest(new URL("http://localhost/api/minipay/sync"), {
    method: "GET",
    headers: bearer ? { authorization: `Bearer ${bearer}` } : undefined,
  });
}

describe("GET /api/minipay/sync — auth", () => {
  it("401s when no auth", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it("rejects wrong bearer", async () => {
    const res = await GET(makeReq("wrong"));
    expect(res.status).toBe(401);
  });

  it("500s when DUNE_API_KEY missing", async () => {
    vi.stubEnv("DUNE_API_KEY", "");
    const res = await GET(makeReq("cron-secret"));
    expect(res.status).toBe(500);
  });
});

describe("GET /api/minipay/sync — happy path", () => {
  it("advances cursor only after addToMiniPaySet succeeds", async () => {
    mockGetCursor.mockResolvedValue(BigInt(100));
    mockFetch.mockResolvedValue({
      addresses: ["0xa", "0xb"],
      maxBlock: BigInt(500),
      count: 2,
    });
    mockAdd.mockResolvedValue(2);
    mockSize.mockResolvedValue(2);

    const res = await GET(makeReq("cron-secret"));
    expect(res.status).toBe(200);

    // Critical ordering: SADD must run before cursor write.
    const addOrder = mockAdd.mock.invocationCallOrder[0]!;
    const setOrder = mockSetCursor.mock.invocationCallOrder[0]!;
    expect(addOrder).toBeLessThan(setOrder);

    expect(mockSetCursor).toHaveBeenCalledWith(BigInt(500));
  });

  it("does NOT advance cursor when SADD throws (regression: data loss)", async () => {
    mockGetCursor.mockResolvedValue(BigInt(100));
    mockFetch.mockResolvedValue({
      addresses: ["0xa"],
      maxBlock: BigInt(500),
      count: 1,
    });
    mockAdd.mockRejectedValue(new Error("redis-down"));

    const res = await GET(makeReq("cron-secret"));
    expect(res.status).toBe(500);
    expect(mockSetCursor).not.toHaveBeenCalled();
  });

  it("does NOT advance cursor when Dune returns no rows past cursor", async () => {
    mockGetCursor.mockResolvedValue(BigInt(500));
    mockFetch.mockResolvedValue({
      addresses: [],
      maxBlock: BigInt(0),
      count: 0,
    });
    mockAdd.mockResolvedValue(0);
    mockSize.mockResolvedValue(123);

    const res = await GET(makeReq("cron-secret"));
    expect(res.status).toBe(200);
    expect(mockSetCursor).not.toHaveBeenCalled();
  });

  it("returns DuneAuthError as 502", async () => {
    mockGetCursor.mockResolvedValue(BigInt(0));
    mockFetch.mockRejectedValue(new DuneAuthError("rejected"));

    const res = await GET(makeReq("cron-secret"));
    expect(res.status).toBe(502);
  });
});
