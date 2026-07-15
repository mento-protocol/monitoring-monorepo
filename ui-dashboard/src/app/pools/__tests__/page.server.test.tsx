import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PoolsPage from "../page";

type PoolsPageProps = {
  initialNetworkData?: unknown;
  initialIsWeekend?: boolean;
};

const { mockFetchInitialNetworkData, mockPoolsPageClient } = vi.hoisted(() => ({
  mockFetchInitialNetworkData: vi.fn(),
  mockPoolsPageClient: vi.fn((props: PoolsPageProps) => {
    void props;
    return null;
  }),
}));

vi.mock("@/lib/network-fetcher/server-cache", () => ({
  fetchInitialNetworkData: mockFetchInitialNetworkData,
}));

vi.mock("../_components/pools-page-client", () => ({
  PoolsPageClient: (props: PoolsPageProps) => mockPoolsPageClient(props),
}));

beforeEach(() => {
  mockFetchInitialNetworkData.mockReset();
  mockPoolsPageClient.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PoolsPage server component", () => {
  it("passes resolved initial network data into the client page", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T12:00:00Z"));
    const initialNetworkData = [{ networkId: "celo-mainnet", pools: [] }];
    mockFetchInitialNetworkData.mockResolvedValueOnce({
      networks: initialNetworkData,
      fetchedAtMs: 1_700_000_000_000,
    });

    renderToStaticMarkup(await PoolsPage());

    expect(mockPoolsPageClient).toHaveBeenCalledWith({
      initialNetworkData,
      initialNetworkDataFetchedAtMs: 1_700_000_000_000,
      initialIsWeekend: true,
    });
  });

  it("falls back to client-side fetching when initial network data rejects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T12:00:00Z"));
    mockFetchInitialNetworkData.mockRejectedValueOnce(
      new Error("network fanout"),
    );

    renderToStaticMarkup(await PoolsPage());

    expect(mockPoolsPageClient).toHaveBeenCalledWith({
      initialNetworkData: undefined,
      initialNetworkDataFetchedAtMs: undefined,
      initialIsWeekend: false,
    });
  });
});
