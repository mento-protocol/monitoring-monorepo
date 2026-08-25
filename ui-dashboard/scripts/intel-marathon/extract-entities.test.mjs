import { describe, expect, it, vi } from "vitest";
import {
  fetchHashViaHscan,
  fetchHashValuesViaHscan,
  HSCAN_MAX_PAGES,
} from "./extract-entities.mjs";

function hscanResponse(cursor, flat) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ result: [cursor, flat] }),
  };
}

describe("fetchHashViaHscan", () => {
  it("never issues a whole-hash HGETALL/HVALS — pages through HSCAN and merges every page", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        hscanResponse("7", ["0xaaa", '{"v":1}', "0xbbb", '{"v":2}']),
      )
      .mockResolvedValueOnce(hscanResponse("0", ["0xccc", '{"v":3}']));

    const flat = await fetchHashViaHscan("intel_deep", { fetchImpl });

    expect(flat).toEqual([
      "0xaaa",
      '{"v":1}',
      "0xbbb",
      '{"v":2}',
      "0xccc",
      '{"v":3}',
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toContain("/hscan/intel_deep/0");
    expect(fetchImpl.mock.calls[1][0]).toContain("/hscan/intel_deep/7");
    expect(
      fetchImpl.mock.calls.some(
        ([url]) => url.includes("/hgetall/") || url.includes("/hvals/"),
      ),
    ).toBe(false);
  });

  it("keeps the later page's value when HSCAN returns the same field twice", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(hscanResponse("3", ["0xaaa", '"stale"']))
      .mockResolvedValueOnce(hscanResponse("0", ["0xaaa", '"fresh"']));

    const flat = await fetchHashViaHscan("intel_deep", { fetchImpl });

    expect(flat).toEqual(["0xaaa", '"fresh"']);
  });

  it("throws when Upstash answers with HTTP 200 and an error body field", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          error: "ERR max request size exceeded. Limit: 10485760 bytes",
        }),
    });

    await expect(
      fetchHashViaHscan("intel_deep", { fetchImpl }),
    ).rejects.toThrow(/max request size exceeded/);
  });

  it("succeeds when the scan terminates on exactly the page-count bound", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(() => {
      calls++;
      const cursor = calls === HSCAN_MAX_PAGES ? "0" : String(calls);
      return Promise.resolve(
        hscanResponse(cursor, ["0xaaa", `{"v":${calls}}`]),
      );
    });

    const flat = await fetchHashViaHscan("intel_deep", { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(HSCAN_MAX_PAGES);
    expect(flat).toEqual(["0xaaa", `{"v":${HSCAN_MAX_PAGES}}`]);
  });

  it("aborts before requesting one page past the bound when the cursor never returns to 0", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(hscanResponse("never-zero", ["0xaaa", '{"v":1}']));

    await expect(
      fetchHashViaHscan("intel_deep", { fetchImpl }),
    ).rejects.toThrow(/did not terminate/);
    // The bound must reject before a page beyond it is ever requested.
    expect(fetchImpl).toHaveBeenCalledTimes(HSCAN_MAX_PAGES);
  });
});

describe("fetchHashValuesViaHscan", () => {
  it("drops field names and returns only values, matching HVALS's shape", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        hscanResponse("0", ["0xaaa", '{"v":1}', "0xbbb", '{"v":2}']),
      );

    const values = await fetchHashValuesViaHscan("intel_deep", { fetchImpl });

    expect(values).toEqual(['{"v":1}', '{"v":2}']);
  });

  it("merges values across multiple pages", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(hscanResponse("5", ["0xaaa", '{"v":1}']))
      .mockResolvedValueOnce(hscanResponse("0", ["0xbbb", '{"v":2}']));

    const values = await fetchHashValuesViaHscan("intel_deep", { fetchImpl });

    expect(values).toEqual(['{"v":1}', '{"v":2}']);
  });
});
