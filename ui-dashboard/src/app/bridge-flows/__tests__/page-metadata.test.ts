import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateMetadata } from "../page";

const { mockFetchBridgeFlowsOgData } = vi.hoisted(() => ({
  mockFetchBridgeFlowsOgData: vi.fn(),
}));

vi.mock("@/lib/bridge-flows-og", () => ({
  fetchBridgeFlowsOgData: mockFetchBridgeFlowsOgData,
}));

vi.mock("../_components/bridge-flows-page-client", () => ({
  BridgeFlowsPageClient: () => null,
}));

beforeEach(() => {
  mockFetchBridgeFlowsOgData.mockReset();
});

describe("BridgeFlowsPage route metadata", () => {
  it("returns the static fallback description when OG data is unavailable", async () => {
    mockFetchBridgeFlowsOgData.mockResolvedValueOnce(null);

    const metadata = await generateMetadata();

    expect(metadata.description).toBe(
      "Wormhole bridge transfers of Mento stable tokens across Celo and Monad.",
    );
    expect(metadata.openGraph).toEqual(
      expect.objectContaining({ description: metadata.description }),
    );
    expect(metadata.twitter).toEqual(
      expect.objectContaining({ description: metadata.description }),
    );
  });

  it("includes zero metrics when snapshots return empty results", async () => {
    mockFetchBridgeFlowsOgData.mockResolvedValueOnce({
      chains: ["Celo", "Monad"],
      volume30dUsd: 0,
      totalTransfers30d: 0,
    });

    const metadata = await generateMetadata();

    expect(metadata.description).toContain("30d bridged volume $0.00");
    expect(metadata.description).toContain("0 transfers");
    expect(metadata.description).toContain("on Celo + Monad");
  });

  it("builds a populated bridge-flow description", async () => {
    mockFetchBridgeFlowsOgData.mockResolvedValueOnce({
      chains: ["Celo", "Monad"],
      volume30dUsd: 1_250_000,
      totalTransfers30d: 42,
    });

    const metadata = await generateMetadata();

    expect(metadata.description).toContain("30d bridged volume");
    expect(metadata.description).toContain("42 transfers");
    expect(metadata.description).toContain("on Celo + Monad");
  });

  it("falls back when all metric fields are null", async () => {
    mockFetchBridgeFlowsOgData.mockResolvedValueOnce({
      chains: ["Celo", "Monad"],
      volume30dUsd: null,
      totalTransfers30d: null,
    });

    const metadata = await generateMetadata();

    expect(metadata.description).toBe(
      "Wormhole bridge transfers of Mento stable tokens across Celo and Monad.",
    );
  });
});
