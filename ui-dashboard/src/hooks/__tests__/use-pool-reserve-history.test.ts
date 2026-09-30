import { beforeEach, describe, expect, it, vi } from "vitest";
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

beforeEach(() => {
  mocks.swr.mockReset();
  mocks.fetch.mockReset();
  mocks.network.hasuraUrl = "https://example.com/graphql";
  mocks.swr.mockReturnValue({ data: undefined, isLoading: true });
});

describe("usePoolReserveHistory", () => {
  it("keys history by endpoint, network, pool, and selected range without table state", async () => {
    const result = usePoolReserveHistory("pool-a", "All");
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
      refreshInterval: 0,
    });
    expect(config).toMatchObject({
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      refreshInterval: 0,
    });
    await fetcher();
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://example.com/graphql",
      "pool-a",
      "All",
    );
    expect(result.isLoading).toBe(true);
    expect(result.data).toBeUndefined();
  });

  it("does not retain another range's rows while the new range loads", () => {
    usePoolReserveHistory("pool-a", "1h");
    expect(mocks.swr.mock.calls[0]![2].keepPreviousData).toBeUndefined();
  });

  it("skips fetching when the chart cannot use token decimals", () => {
    usePoolReserveHistory("pool-a", "All", false);
    expect(mocks.swr.mock.calls[0]![0]).toBeNull();
  });

  it("reports an unconfigured endpoint and skips fetching", () => {
    mocks.network.hasuraUrl = "";
    const result = usePoolReserveHistory("pool-a", "1d");
    expect(mocks.swr.mock.calls[0]![0]).toBeNull();
    expect(result.error?.message).toContain("not configured");
  });
});
