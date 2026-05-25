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
  advanceLastSyncedBlock: vi.fn(),
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
  advanceLastSyncedBlock,
} from "@/lib/minipay";
import * as Sentry from "@sentry/nextjs";

const mockFetch = vi.mocked(fetchMiniPayUsers);
const mockAdd = vi.mocked(addToMiniPaySet);
const mockSize = vi.mocked(getMiniPaySetSize);
const mockGetCursor = vi.mocked(getLastSyncedBlock);
const mockAdvanceCursor = vi.mocked(advanceLastSyncedBlock);
const mockWithMonitor = vi.mocked(Sentry.withMonitor);

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

// Helper: build an async generator from an array of pages (or a thrown error).
async function* yieldPages(
  pages: Array<{ addresses: string[]; maxBlock: bigint } | Error>,
) {
  for (const p of pages) {
    if (p instanceof Error) throw p;
    yield p;
  }
}

describe("GET /api/minipay/sync — happy path", () => {
  it("advances cursor only after addToMiniPaySet succeeds", async () => {
    mockGetCursor.mockResolvedValue(BigInt(100));
    mockFetch.mockReturnValue(
      yieldPages([{ addresses: ["0xa", "0xb"], maxBlock: BigInt(500) }]),
    );
    mockAdd.mockResolvedValue(2);
    mockSize.mockResolvedValue(2);

    const res = await GET(makeReq("cron-secret"));
    expect(res.status).toBe(200);

    // Critical ordering: SADD must run before cursor write.
    const addOrder = mockAdd.mock.invocationCallOrder[0]!;
    const setOrder = mockAdvanceCursor.mock.invocationCallOrder[0]!;
    expect(addOrder).toBeLessThan(setOrder);

    expect(mockAdvanceCursor).toHaveBeenCalledWith(BigInt(500));
  });

  it("keeps Sentry maxRuntime aligned with the route execution budget", async () => {
    mockGetCursor.mockResolvedValue(BigInt(100));
    mockFetch.mockReturnValue(yieldPages([]));
    mockSize.mockResolvedValue(2);

    const res = await GET(makeReq("cron-secret"));
    expect(res.status).toBe(200);
    expect(mockWithMonitor).toHaveBeenCalledWith(
      "minipay-sync",
      expect.any(Function),
      expect.objectContaining({ maxRuntime: 800 }),
    );
  });

  it("does NOT advance cursor when SADD throws (regression: data loss)", async () => {
    mockGetCursor.mockResolvedValue(BigInt(100));
    mockFetch.mockReturnValue(
      yieldPages([{ addresses: ["0xa"], maxBlock: BigInt(500) }]),
    );
    mockAdd.mockRejectedValue(new Error("redis-down"));

    const res = await GET(makeReq("cron-secret"));
    expect(res.status).toBe(500);
    expect(mockAdvanceCursor).not.toHaveBeenCalled();
  });

  it("does NOT advance cursor when Dune returns no rows past cursor", async () => {
    mockGetCursor.mockResolvedValue(BigInt(500));
    mockFetch.mockReturnValue(yieldPages([])); // generator yields no pages
    mockAdd.mockResolvedValue(0);
    mockSize.mockResolvedValue(123);

    const res = await GET(makeReq("cron-secret"));
    expect(res.status).toBe(200);
    expect(mockAdvanceCursor).not.toHaveBeenCalled();
  });

  it("SADDs each page incrementally (memory-bounded streaming)", async () => {
    mockGetCursor.mockResolvedValue(BigInt(100));
    mockFetch.mockReturnValue(
      yieldPages([
        { addresses: ["0xa", "0xb"], maxBlock: BigInt(100) },
        { addresses: ["0xc"], maxBlock: BigInt(200) },
        { addresses: ["0xd", "0xe"], maxBlock: BigInt(300) },
      ]),
    );
    mockAdd
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    mockSize.mockResolvedValue(5);

    const res = await GET(makeReq("cron-secret"));
    expect(res.status).toBe(200);
    // SADD called once per yielded page, not once at the end.
    expect(mockAdd).toHaveBeenCalledTimes(3);
    expect(mockAdd).toHaveBeenNthCalledWith(1, ["0xa", "0xb"]);
    expect(mockAdd).toHaveBeenNthCalledWith(2, ["0xc"]);
    expect(mockAdd).toHaveBeenNthCalledWith(3, ["0xd", "0xe"]);
    // Cursor advances to the highest maxBlock seen across all pages.
    expect(mockAdvanceCursor).toHaveBeenCalledWith(BigInt(300));
  });

  it("preserves earlier-page SADDs when a later page throws — cursor unchanged", async () => {
    mockGetCursor.mockResolvedValue(BigInt(100));
    mockFetch.mockReturnValue(
      yieldPages([
        { addresses: ["0xa"], maxBlock: BigInt(100) },
        new Error("dune-page-2-failed"),
      ]),
    );
    mockAdd.mockResolvedValue(1);

    const res = await GET(makeReq("cron-secret"));
    expect(res.status).toBe(500);
    // Page 1's SADD ran (rows now in Redis); cursor stayed put so next run
    // re-pulls page 1 (idempotent SADD) and retries page 2.
    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect(mockAdd).toHaveBeenCalledWith(["0xa"]);
    expect(mockAdvanceCursor).not.toHaveBeenCalled();
  });

  it("requires the bulk seed before first cron sync", async () => {
    mockGetCursor.mockResolvedValue(BigInt(0));

    const res = await GET(makeReq("cron-secret"));
    expect(res.status).toBe(409);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockAdvanceCursor).not.toHaveBeenCalled();
  });

  it("returns DuneAuthError as 502", async () => {
    mockGetCursor.mockResolvedValue(BigInt(100));
    mockFetch.mockReturnValue(yieldPages([new DuneAuthError("rejected")]));

    const res = await GET(makeReq("cron-secret"));
    expect(res.status).toBe(502);
  });
});
