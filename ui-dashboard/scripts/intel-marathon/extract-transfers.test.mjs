import { describe, expect, it, vi } from "vitest";
import { fetchHashViaHscan, HSCAN_MAX_PAGES } from "./extract-transfers.mjs";

function hscanResponse(cursor, flat) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ result: [cursor, flat] }),
  };
}

describe("fetchHashViaHscan", () => {
  it("never issues a whole-hash HGETALL — pages through HSCAN and merges every page", async () => {
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
    // Refusing a whole-hash call proves the fix never falls back to it:
    // intel_deep already exceeds Upstash REST's 10MB single-response cap.
    expect(
      fetchImpl.mock.calls.some(([url]) => url.includes("/hgetall/")),
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
    // Live-observed failure mode: an oversized HGETALL comes back HTTP 200
    // with an `error` field in the JSON body, so `res.ok` alone can't catch
    // it. HSCAN pages are small enough to avoid the cap, but the same
    // defensive check applies to every page in case Upstash rejects one for
    // another reason.
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
