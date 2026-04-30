import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @upstash/redis before importing the module under test (mirrors
// address-labels.test.ts pattern).
vi.mock("@upstash/redis", () => {
  const Redis = vi.fn();
  Redis.prototype.sadd = vi.fn();
  Redis.prototype.scard = vi.fn();
  Redis.prototype.smismember = vi.fn();
  Redis.prototype.get = vi.fn();
  Redis.prototype.set = vi.fn();
  return { Redis };
});

vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://fake.upstash.io");
vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "fake-token");

import { Redis } from "@upstash/redis";
import {
  addToMiniPaySet,
  fetchMiniPayUsers,
  getLastSyncedBlock,
  getMiniPaySetSize,
  intersectMiniPay,
  setLastSyncedBlock,
  toMiniPayEntry,
  DuneAuthError,
  DuneExecutionError,
} from "@/lib/minipay";

const saddMock = Redis.prototype.sadd as ReturnType<typeof vi.fn>;
const scardMock = Redis.prototype.scard as ReturnType<typeof vi.fn>;
const smismemberMock = Redis.prototype.smismember as ReturnType<typeof vi.fn>;
const getMock = Redis.prototype.get as ReturnType<typeof vi.fn>;
const setMock = Redis.prototype.set as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  saddMock.mockReset();
  scardMock.mockReset();
  smismemberMock.mockReset();
  getMock.mockReset();
  setMock.mockReset();
});

describe("addToMiniPaySet", () => {
  it("returns 0 and skips Redis when input is empty", async () => {
    const added = await addToMiniPaySet([]);
    expect(added).toBe(0);
    expect(saddMock).not.toHaveBeenCalled();
  });

  it("chunks SADD calls in batches of 1000", async () => {
    saddMock.mockResolvedValue(500); // each batch reports half-new
    const addrs = Array.from(
      { length: 2_500 },
      (_, i) => `0x${i.toString(16).padStart(40, "0")}`,
    );
    const added = await addToMiniPaySet(addrs);

    expect(saddMock).toHaveBeenCalledTimes(3);
    expect(added).toBe(1500);
    // First call should have exactly 1000 args after the key
    const firstArgs = saddMock.mock.calls[0]!;
    expect(firstArgs[0]).toBe("minipay:users");
    expect(firstArgs.length).toBe(1 + 1000);
    // Last call should have the remainder (500)
    const lastArgs = saddMock.mock.calls[2]!;
    expect(lastArgs.length).toBe(1 + 500);
  });
});

describe("getMiniPaySetSize", () => {
  it("returns SCARD result", async () => {
    scardMock.mockResolvedValue(4_823_119);
    const size = await getMiniPaySetSize();
    expect(size).toBe(4_823_119);
    expect(scardMock).toHaveBeenCalledWith("minipay:users");
  });
});

describe("intersectMiniPay", () => {
  it("returns empty for empty input without hitting Redis", async () => {
    const result = await intersectMiniPay([]);
    expect(result).toEqual([]);
    expect(smismemberMock).not.toHaveBeenCalled();
  });

  it("returns only the addresses with flag=1", async () => {
    const addrs = ["0xa", "0xb", "0xc", "0xd"];
    smismemberMock.mockResolvedValueOnce([1, 0, 1, 0]);
    const result = await intersectMiniPay(addrs);
    expect(result).toEqual(["0xa", "0xc"]);
  });

  it("chunks SMISMEMBER calls and stitches positives across batches", async () => {
    const addrs = Array.from(
      { length: 1_500 },
      (_, i) => `0x${i.toString(16).padStart(40, "0")}`,
    );
    // First batch (1000): only index 0 is a member.
    // Second batch (500): only index 0 is a member.
    smismemberMock.mockResolvedValueOnce([1, ...new Array(999).fill(0)]);
    smismemberMock.mockResolvedValueOnce([1, ...new Array(499).fill(0)]);

    const result = await intersectMiniPay(addrs);
    expect(smismemberMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(addrs[0]);
    expect(result[1]).toBe(addrs[1000]);
  });
});

describe("cursor helpers", () => {
  it("getLastSyncedBlock returns BigInt(0) when key is missing", async () => {
    getMock.mockResolvedValue(null);
    expect(await getLastSyncedBlock()).toBe(BigInt(0));
  });

  it("getLastSyncedBlock parses string cursor", async () => {
    getMock.mockResolvedValue("1234567890");
    expect(await getLastSyncedBlock()).toBe(BigInt(1234567890));
  });

  it("getLastSyncedBlock throws on garbage input — surface, don't silently reset", async () => {
    getMock.mockResolvedValue("not-a-number");
    await expect(getLastSyncedBlock()).rejects.toThrow();
  });

  it("setLastSyncedBlock writes BigInt as decimal string", async () => {
    setMock.mockResolvedValue("OK");
    await setLastSyncedBlock(BigInt(99999));
    expect(setMock).toHaveBeenCalledWith("minipay:lastBlock", "99999");
  });
});

describe("toMiniPayEntry", () => {
  it("emits canonical AddressEntry shape with source=minipay", () => {
    const entry = toMiniPayEntry();
    expect(entry.name).toBe("MiniPay user");
    expect(entry.tags).toEqual(["minipay"]);
    expect(entry.source).toBe("minipay");
    expect(entry.isPublic).toBe(false);
    expect(entry.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("fetchMiniPayUsers (Dune client)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws DuneAuthError on 401", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("unauthorized", {
          status: 401,
          statusText: "Unauthorized",
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const gen = fetchMiniPayUsers({ apiKey: "bad", lastBlock: BigInt(0) });
    await expect(gen.next()).rejects.toBeInstanceOf(DuneAuthError);
  });

  it("posts lastBlock as a string parameter to /execute", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/execute")) {
        const body = JSON.parse(String(init?.body));
        expect(body.query_parameters.lastBlock).toBe("12345");
        return new Response(
          JSON.stringify({ execution_id: "exec-1", state: "PENDING" }),
          { status: 200 },
        );
      }
      if (url.includes("/status")) {
        return new Response(
          JSON.stringify({
            execution_id: "exec-1",
            state: "QUERY_STATE_COMPLETED",
          }),
          { status: 200 },
        );
      }
      // Results call
      return new Response(
        JSON.stringify({
          execution_id: "exec-1",
          state: "QUERY_STATE_COMPLETED",
          result: { rows: [], metadata: {} },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const pages = [];
    for await (const page of fetchMiniPayUsers({
      apiKey: "ok",
      lastBlock: BigInt(12345),
    })) {
      pages.push(page);
    }
    // Empty result yields no pages (generator skips zero-row pages).
    expect(pages).toHaveLength(0);
  });

  it("yields per page with maxBlock advancing across pages", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/execute")) {
        return new Response(
          JSON.stringify({ execution_id: "exec-2", state: "PENDING" }),
          { status: 200 },
        );
      }
      if (url.includes("/status")) {
        return new Response(
          JSON.stringify({
            execution_id: "exec-2",
            state: "QUERY_STATE_COMPLETED",
          }),
          { status: 200 },
        );
      }
      // Results: page 1 then page 2 (no next_offset → done).
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            execution_id: "exec-2",
            state: "QUERY_STATE_COMPLETED",
            result: {
              rows: [
                {
                  account: "0xAAAA000000000000000000000000000000000000",
                  max_block: "100",
                },
                {
                  account: "0xBBBB000000000000000000000000000000000000",
                  max_block: "200",
                },
              ],
              metadata: { next_offset: 2 },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          execution_id: "exec-2",
          state: "QUERY_STATE_COMPLETED",
          result: {
            rows: [
              // Duplicate of page 1's first row — must be deduped
              {
                account: "0xaaaa000000000000000000000000000000000000",
                max_block: "100",
              },
              {
                account: "0xCCCC000000000000000000000000000000000000",
                max_block: "300",
              },
            ],
            metadata: {},
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const pages = [];
    for await (const page of fetchMiniPayUsers({
      apiKey: "ok",
      lastBlock: BigInt(0),
    })) {
      pages.push(page);
    }

    // Two pages yielded — generator does not dedup across pages (the Dune
    // query groups by account, so cross-page duplicates can't happen by
    // construction; SADD idempotency covers any pathological case).
    expect(pages).toHaveLength(2);
    expect(pages[0]!.addresses).toEqual([
      "0xaaaa000000000000000000000000000000000000",
      "0xbbbb000000000000000000000000000000000000",
    ]);
    expect(pages[0]!.maxBlock).toBe(BigInt(200));
    expect(pages[1]!.addresses).toEqual([
      "0xaaaa000000000000000000000000000000000000",
      "0xcccc000000000000000000000000000000000000",
    ]);
    expect(pages[1]!.maxBlock).toBe(BigInt(300));
  });

  it("throws DuneExecutionError on FAILED state", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/execute")) {
        return new Response(
          JSON.stringify({ execution_id: "exec-fail", state: "PENDING" }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          execution_id: "exec-fail",
          state: "QUERY_STATE_FAILED",
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const gen = fetchMiniPayUsers({ apiKey: "ok", lastBlock: BigInt(0) });
    await expect(gen.next()).rejects.toBeInstanceOf(DuneExecutionError);
  });
});
