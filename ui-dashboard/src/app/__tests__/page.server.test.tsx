import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import HomePage, { generateMetadata } from "../page";

type GlobalPageProps = { initialNetworkData?: unknown };

const { mockFetchAllNetworks, mockFetchHomepageOgData, mockGlobalPage } =
  vi.hoisted(() => ({
    mockFetchAllNetworks: vi.fn(),
    mockFetchHomepageOgData: vi.fn(),
    mockGlobalPage: vi.fn((props: GlobalPageProps) => {
      void props;
      return null;
    }),
  }));

vi.mock("@/lib/fetch-all-networks", () => ({
  fetchAllNetworks: mockFetchAllNetworks,
}));

vi.mock("@/lib/homepage-og", () => ({
  fetchHomepageOgData: mockFetchHomepageOgData,
}));

vi.mock("../page-client", () => ({
  default: (props: GlobalPageProps) => mockGlobalPage(props),
}));

const homepageOgData = {
  chains: ["Celo", "Monad"],
  offlineChains: [],
  partial: false,
  totalTvlUsd: 1_000_000,
  tvlWoWPct: null,
  totalVolume7dUsd: 250_000,
  volume7dWoWPct: null,
  volumeSeries: [],
  tvlSeries: [],
  poolCount: 12,
  chainCount: 2,
  healthBuckets: { OK: 12, WARN: 0, CRITICAL: 0, WEEKEND: 0, "N/A": 0 },
  attentionPools: [],
};

beforeEach(() => {
  mockFetchAllNetworks.mockReset();
  mockFetchHomepageOgData.mockReset();
  mockGlobalPage.mockClear();
});

describe("HomePage route metadata", () => {
  it("returns fallback metadata when homepage OG data is unavailable", async () => {
    mockFetchHomepageOgData.mockResolvedValueOnce(null);

    const metadata = await generateMetadata();

    expect(metadata).toMatchObject({
      title: "Mento Analytics",
      description: "Cross-chain analytics dashboard for Mento protocol",
      openGraph: {
        title: "Mento Analytics",
        description: "Cross-chain analytics dashboard for Mento protocol",
        type: "website",
      },
      twitter: {
        card: "summary_large_image",
        title: "Mento Analytics",
        description: "Cross-chain analytics dashboard for Mento protocol",
      },
    });
  });

  it("builds metadata from homepage OG data", async () => {
    mockFetchHomepageOgData.mockResolvedValueOnce(homepageOgData);

    const metadata = await generateMetadata();

    expect(metadata.description).toContain("TVL $1M");
    expect(metadata.description).toContain("7d volume");
    expect(metadata.description).toContain("12 pools on Celo + Monad");
    expect(metadata.openGraph).toEqual(
      expect.objectContaining({ description: metadata.description }),
    );
  });
});

describe("HomePage server component", () => {
  it("passes resolved initial network data into the client page", async () => {
    const initialNetworkData = [{ networkId: "celo-mainnet", pools: [] }];
    mockFetchAllNetworks.mockResolvedValueOnce(initialNetworkData);

    renderToStaticMarkup(await HomePage());

    expect(mockGlobalPage).toHaveBeenCalledWith({ initialNetworkData });
  });

  it("falls back to client-side fetching when initial network data rejects", async () => {
    mockFetchAllNetworks.mockRejectedValueOnce(new Error("network fanout"));

    renderToStaticMarkup(await HomePage());

    expect(mockGlobalPage).toHaveBeenCalledWith({
      initialNetworkData: undefined,
    });
  });
});
