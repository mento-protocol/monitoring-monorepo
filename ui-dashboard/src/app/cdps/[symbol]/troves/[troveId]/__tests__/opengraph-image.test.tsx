import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TroveOgData } from "../_lib/trove-og-data";

const imageResponseCalls: { element: unknown; options: unknown }[] = [];

vi.mock("next/og", () => ({
  ImageResponse: function MockImageResponse(
    this: Record<string, unknown>,
    element: unknown,
    options: unknown,
  ) {
    imageResponseCalls.push({ element, options });
    this.element = element;
    this.options = options;
  },
}));

const fetchForMetadata = vi.fn();
vi.mock("../_lib/trove-og-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../_lib/trove-og-data")>()),
  fetchTroveOgDataForMetadata: (...args: unknown[]) =>
    fetchForMetadata(...args),
}));

const data: TroveOgData = {
  symbol: "GBPm",
  troveId: "0x8abc",
  status: "active",
  statusLabel: "Active",
  statusTone: "healthy",
  collateral: "44.79K USDm",
  debt: "28.08K GBPm",
  icr: "117.10%",
  openedDate: "2026-08-18",
  lastEventLabel: "Last indexed",
  lastEventDate: "2026-08-28",
  fetchedAtMs: Date.UTC(2026, 7, 28),
};

const {
  buildTroveOgAlt,
  buildImageCacheControl,
  contentType,
  default: Image,
  generateImageMetadata,
  size,
} = await import("../opengraph-image");
const { TroveOgCard } = await import("../_og/trove-og-card");

beforeEach(() => {
  imageResponseCalls.length = 0;
  fetchForMetadata.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(data.fetchedAtMs + 2 * 60 * 1_000);
});

afterEach(() => vi.useRealTimers());

describe("trove opengraph-image route", () => {
  it("declares the social-preview dimensions", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
  });

  it("builds data-rich alt text and canonicalizes the route id", async () => {
    fetchForMetadata.mockResolvedValue(data);

    const [entry] = await generateImageMetadata({
      params: Promise.resolve({ symbol: "GBPM", troveId: "0x0008ABC" }),
    });

    expect(fetchForMetadata).toHaveBeenCalledWith("GBPM", "0x8abc");
    expect(entry?.alt).toBe(
      "Mento Analytics · GBPM Trove 0x8abc · Active · collateral 44.79K USDm · debt 28.08K GBPm · indexed ICR 117.10% · last indexed 2026-08-28",
    );
    expect(entry?.size).toEqual(size);
  });

  it("uses explicit unavailable language when the data fetch fails", () => {
    expect(buildTroveOgAlt(null, { symbol: "gbpm", troveId: "0x8abc" })).toBe(
      "Mento Analytics · GBPM Trove 0x8abc · indexed snapshot unavailable",
    );
  });

  it("renders the confirmed values and omits the batch rate", () => {
    const markup = renderToStaticMarkup(
      <TroveOgCard
        data={data}
        identity={{ symbol: "gbpm", troveId: "0x8abc" }}
      />,
    );

    expect(markup).toContain("44.79K USDm");
    expect(markup).toContain("28.08K GBPm");
    expect(markup).toContain("117.10%");
    expect(markup).toContain("INDEXED ICR");
    expect(markup).toContain("2026-08-18");
    expect(markup).not.toContain(">RATE<");
  });

  it("renders a neutral fallback without asserting a position state", () => {
    const markup = renderToStaticMarkup(
      <TroveOgCard
        data={null}
        identity={{ symbol: "gbpm", troveId: "0x8abc" }}
      />,
    );

    expect(markup).toContain("Data unavailable");
    expect(markup).toContain(
      "The indexed snapshot is temporarily unavailable.",
    );
    expect(markup).not.toContain(">Active<");
  });

  it("passes the cache policy and fonts to ImageResponse", async () => {
    fetchForMetadata.mockResolvedValue(data);

    await Image({
      params: Promise.resolve({ symbol: "gbpm", troveId: "0x8abc" }),
    });

    expect(imageResponseCalls).toHaveLength(1);
    expect(imageResponseCalls[0]!.options).toMatchObject({
      width: 1200,
      height: 630,
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=60, must-revalidate",
      },
    });
    const { fonts } = imageResponseCalls[0]!.options as {
      fonts?: { name: string; weight: number }[];
    };
    expect(fonts?.map((font) => font.weight).sort()).toEqual([
      400, 600, 700, 800,
    ]);
  });

  it("does not cache the image beyond the source freshness boundary", () => {
    expect(
      buildImageCacheControl(data, data.fetchedAtMs + 4 * 60 * 1_000 + 45_000),
    ).toBe("public, max-age=0, s-maxage=15, must-revalidate");
    expect(
      buildImageCacheControl(data, data.fetchedAtMs + 5 * 60 * 1_000),
    ).toBe("public, max-age=0, s-maxage=0, must-revalidate");
    expect(buildImageCacheControl(null)).toBe(
      "public, max-age=0, s-maxage=60, must-revalidate",
    );
  });
});
