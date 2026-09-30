// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach } from "vitest";
import { usePoolReserveHistory } from "../use-pool-reserve-history";
import { SHARED_QUERY_SWR_CONFIG } from "@/lib/gql-retry";

const mocks = vi.hoisted(() => ({
  swr: vi.fn(),
  fetch: vi.fn(),
  network: { id: "celo-mainnet", hasuraUrl: "https://example.com/graphql" },
}));
vi.mock("swr", () => ({ default: mocks.swr }));
vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({ network: mocks.network }),
}));
vi.mock("@/lib/pool-reserve-history", () => ({
  fetchPoolReserveHistory: mocks.fetch,
}));

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let previousActEnvironment: boolean | undefined;
afterEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment ?? false;
});

function renderHistory(...args: Parameters<typeof usePoolReserveHistory>) {
  let result!: ReturnType<typeof usePoolReserveHistory>;
  function Probe() {
    result = usePoolReserveHistory(...args);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return result;
}

beforeEach(() => {
  previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.swr.mockReset();
  mocks.fetch.mockReset();
  mocks.network.hasuraUrl = "https://example.com/graphql";
  mocks.swr.mockReturnValue({ data: undefined, isLoading: true });
});

describe("usePoolReserveHistory", () => {
  it("keys history by endpoint, network, pool, and selected range without table state", async () => {
    const result = renderHistory("pool-a", "All");
    const [key, fetcher, config] = mocks.swr.mock.calls[0]!;
    expect(key).toEqual([
      "pool-reserve-history",
      "celo-mainnet",
      "https://example.com/graphql",
      "pool-a",
      "All",
    ]);
    expect(config).toMatchObject({
      ...SHARED_QUERY_SWR_CONFIG,
      refreshInterval: expect.any(Function),
    });
    expect(config).toMatchObject({
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      refreshInterval: expect.any(Function),
    });
    expect(config.refreshInterval(undefined)).toBe(300000);
    expect(config.refreshInterval({ truncated: true })).toBe(0);
    expect(
      config.shouldRetryOnError(new DOMException("aborted", "AbortError")),
    ).toBe(false);
    await fetcher();
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://example.com/graphql",
      "pool-a",
      "All",
      { previous: undefined, signal: expect.any(AbortSignal) },
    );
    expect(result.isLoading).toBe(true);
    expect(result.data).toBeUndefined();
  });

  it("does not retain another range's rows while the new range loads", () => {
    renderHistory("pool-a", "1h");
    expect(mocks.swr.mock.calls[0]![2].keepPreviousData).toBeUndefined();
  });

  it("skips fetching when the chart cannot use token decimals", () => {
    renderHistory("pool-a", "All", false);
    expect(mocks.swr.mock.calls[0]![0]).toBeNull();
  });

  it("reports an unconfigured endpoint and skips fetching", () => {
    mocks.network.hasuraUrl = "";
    const result = renderHistory("pool-a", "1d");
    expect(mocks.swr.mock.calls[0]![0]).toBeNull();
    expect(result.error?.message).toContain("not configured");
  });
  it("aborts obsolete pagination on range changes and unmount", async () => {
    mocks.fetch.mockImplementation(
      (_endpoint, _pool, _range, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    function Probe({ range }: { range: "All" | "1h" }) {
      usePoolReserveHistory("pool-a", range);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(createElement(Probe, { range: "All" }));
    });
    const pending = mocks.swr.mock.calls.at(-1)![1]();
    const cancelled = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await act(async () => {
      root.render(createElement(Probe, { range: "1h" }));
    });
    await cancelled;
    const next = mocks.swr.mock.calls.at(-1)![1]();
    const unmounted = expect(next).rejects.toMatchObject({
      name: "AbortError",
    });
    await act(async () => {
      root.unmount();
    });
    await unmounted;
  });
});
