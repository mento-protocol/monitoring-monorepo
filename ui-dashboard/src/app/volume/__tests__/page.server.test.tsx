import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { VolumeHeroInitialData } from "@/lib/volume-hero-initial-data";
import type { ChainFilterOption } from "@/lib/chain-filter";
import VolumePage from "../page";

type VolumeClientProps = {
  canUseVolumeFilters: boolean;
  chainOptions: readonly ChainFilterOption[];
  initialData?: VolumeHeroInitialData | undefined;
  initialUtcDayKey?: number | undefined;
};

const { mockGetAuthSession, mockFetchVolumeHeroForSSR, mockVolumeClient } =
  vi.hoisted(() => ({
    mockGetAuthSession: vi.fn(),
    mockFetchVolumeHeroForSSR: vi.fn(),
    mockVolumeClient: vi.fn((props: VolumeClientProps) => {
      void props;
      return null;
    }),
  }));

vi.mock("@/auth", () => ({
  getAuthSession: mockGetAuthSession,
}));

vi.mock("@/lib/volume-ssr", () => ({
  fetchVolumeHeroForSSR: mockFetchVolumeHeroForSSR,
}));

vi.mock("../page-client", () => ({
  VolumeClient: (props: VolumeClientProps) => mockVolumeClient(props),
}));

// Fixed clock so the expected todayMidnight is deterministic (2026-07-09
// 12:00 UTC → midnight = 2026-07-09 00:00 UTC).
const NOW = new Date("2026-07-09T12:00:00Z");
const TODAY_MIDNIGHT = Math.floor(NOW.getTime() / 1000 / 86_400) * 86_400;
const CHAIN_OPTIONS: readonly ChainFilterOption[] = [];

const INITIAL_DATA: VolumeHeroInitialData = {
  view: {
    networkId: "celo-mainnet",
    venue: "v3",
    range: "7d",
    includeProtocolActors: true,
    chainIdIn: [],
    todayMidnight: TODAY_MIDNIGHT,
  },
  heroV3: { volumeWindowSnapshots: [] },
  todayV3: { volumeTodayTraders: [] },
};

async function renderVolumePage(
  searchParams?: Record<string, string | string[] | undefined>,
) {
  renderToStaticMarkup(
    await VolumePage(
      searchParams === undefined
        ? {}
        : { searchParams: Promise.resolve(searchParams) },
    ),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockGetAuthSession.mockReset();
  mockFetchVolumeHeroForSSR.mockReset();
  mockVolumeClient.mockClear();
  mockGetAuthSession.mockResolvedValue(null);
  mockFetchVolumeHeroForSSR.mockResolvedValue(INITIAL_DATA);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("VolumePage server component", () => {
  it("prefetches the locked all-actors default view for logged-out visitors", async () => {
    await renderVolumePage({});

    expect(mockFetchVolumeHeroForSSR).toHaveBeenCalledWith(
      "v3",
      "7d",
      true,
      TODAY_MIDNIGHT,
      [],
    );
    expect(mockVolumeClient).toHaveBeenCalledWith({
      canUseVolumeFilters: false,
      chainOptions: CHAIN_OPTIONS,
      initialData: INITIAL_DATA,
      initialUtcDayKey: TODAY_MIDNIGHT / 86_400,
    });
  });

  it("ignores ?actors= for logged-out visitors (session gates the filter)", async () => {
    await renderVolumePage({ actors: "organic" });

    expect(mockFetchVolumeHeroForSSR).toHaveBeenCalledWith(
      "v3",
      "7d",
      true,
      TODAY_MIDNIGHT,
      [],
    );
  });

  it("prefetches the organic default view for logged-in users", async () => {
    mockGetAuthSession.mockResolvedValue({ user: {} });

    await renderVolumePage({});

    expect(mockFetchVolumeHeroForSSR).toHaveBeenCalledWith(
      "v3",
      "7d",
      false,
      TODAY_MIDNIGHT,
      [],
    );
    expect(mockVolumeClient).toHaveBeenCalledWith({
      canUseVolumeFilters: true,
      chainOptions: CHAIN_OPTIONS,
      initialData: INITIAL_DATA,
      initialUtcDayKey: TODAY_MIDNIGHT / 86_400,
    });
  });

  it("parses venue/range/actors from searchParams with url-state semantics", async () => {
    mockGetAuthSession.mockResolvedValue({ user: {} });

    await renderVolumePage({ venue: "v2", range: "90d", actors: "all" });

    expect(mockFetchVolumeHeroForSSR).toHaveBeenCalledWith(
      "v2",
      "90d",
      true,
      TODAY_MIDNIGHT,
      [],
    );
  });

  it("falls back to defaults for invalid venue/range values", async () => {
    await renderVolumePage({ venue: "v9", range: "1y" });

    expect(mockFetchVolumeHeroForSSR).toHaveBeenCalledWith(
      "v3",
      "7d",
      true,
      TODAY_MIDNIGHT,
      [],
    );
  });

  it("renders without searchParams (test harness / non-request renders)", async () => {
    await renderVolumePage();

    expect(mockFetchVolumeHeroForSSR).toHaveBeenCalledWith(
      "v3",
      "7d",
      true,
      TODAY_MIDNIGHT,
      [],
    );
  });

  it("degrades to the client-only path when the prefetch returns undefined", async () => {
    mockFetchVolumeHeroForSSR.mockResolvedValue(undefined);

    await renderVolumePage({});

    expect(mockVolumeClient).toHaveBeenCalledWith({
      canUseVolumeFilters: false,
      chainOptions: CHAIN_OPTIONS,
      initialData: undefined,
      initialUtcDayKey: TODAY_MIDNIGHT / 86_400,
    });
  });
});
