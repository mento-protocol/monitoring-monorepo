import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PoolsPage from "../page";

type PoolsPageProps = { initialNetworkData?: unknown };

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

describe("PoolsPage server component", () => {
  it("passes resolved initial network data into the client page", async () => {
    const initialNetworkData = [{ networkId: "celo-mainnet", pools: [] }];
    mockFetchInitialNetworkData.mockResolvedValueOnce(initialNetworkData);

    renderToStaticMarkup(await PoolsPage());

    expect(mockPoolsPageClient).toHaveBeenCalledWith({ initialNetworkData });
  });

  it("falls back to client-side fetching when initial network data rejects", async () => {
    mockFetchInitialNetworkData.mockRejectedValueOnce(
      new Error("network fanout"),
    );

    renderToStaticMarkup(await PoolsPage());

    expect(mockPoolsPageClient).toHaveBeenCalledWith({
      initialNetworkData: undefined,
    });
  });
});
