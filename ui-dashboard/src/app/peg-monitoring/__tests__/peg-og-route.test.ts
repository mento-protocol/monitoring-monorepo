import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `ImageResponse` is a constructor, so the mock has to be a function rather
 * than an arrow-returning object; it records what the route handed Satori so
 * the assertions can read the options without rendering a PNG.
 */
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
vi.mock("../_lib/peg-og-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../_lib/peg-og-data")>()),
  fetchPegMonitoringForMetadata: () => fetchForMetadata(),
}));

const {
  default: Image,
  generateImageMetadata,
  size,
  contentType,
} = await import("../opengraph-image");

const healthy = {
  summary: "1 of 1 peg healthy",
  qualifier: null,
  tone: "healthy" as const,
  rows: [
    {
      id: "europ-schuman",
      pair: "EUROP / EUR",
      price: "0.999689",
      distance: "3.1 bps below",
      marker: { percent: 47.4, offScale: false },
      status: "Healthy",
      tone: "healthy" as const,
      venue: "Bitvavo EUROP / EUR",
      spread: "6 bps",
      breaker: { label: "Ready", tone: "healthy" as const },
      thresholds: { downsideWarn: 25, downsideCritical: 50, premiumWarn: 25 },
    },
  ],
  omittedCount: 0,
  cadence: "Checks every 30s",
  age: "12s",
  stale: false,
};

beforeEach(() => {
  imageResponseCalls.length = 0;
  fetchForMetadata.mockReset();
});

describe("peg-monitoring opengraph-image route", () => {
  it("declares the unfurl contract social platforms read", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
  });

  it("builds alt text carrying the verdict and every row", async () => {
    fetchForMetadata.mockResolvedValue(healthy);

    const [entry] = await generateImageMetadata();

    expect(entry?.alt).toBe(
      "Mento peg monitoring · 1 of 1 peg healthy · EUROP / EUR 0.999689, 3.1 bps below, Healthy",
    );
    expect(entry?.size).toEqual(size);
  });

  it("carries the stale qualifier the header pill drops for width", async () => {
    fetchForMetadata.mockResolvedValue({
      ...healthy,
      summary: "0 of 1 peg healthy · 1 unconfirmed",
      qualifier: "latest data is stale",
      tone: "uncertain" as const,
      stale: true,
    });

    const [entry] = await generateImageMetadata();

    expect(entry?.alt).toContain("latest data is stale");
  });

  it("never claims a verdict when the bridge is unreachable", async () => {
    fetchForMetadata.mockResolvedValue(null);

    const [entry] = await generateImageMetadata();

    expect(entry?.alt).toBe("Mento peg monitoring — status unavailable");
    expect(entry?.alt).not.toMatch(/healthy/i);
  });

  it("renders through ImageResponse at the declared size and cache policy", async () => {
    fetchForMetadata.mockResolvedValue(healthy);

    await Image();

    expect(imageResponseCalls).toHaveLength(1);
    expect(imageResponseCalls[0]!.options).toMatchObject({
      width: 1200,
      height: 630,
      headers: {
        // 5 minutes of stale replay, not the 24h the other cards use: this
        // card states an alert condition, and the window bounds how far into a
        // breach a CDN may still answer with a healthy render.
        "Cache-Control":
          "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
      },
    });
  });

  it("loads real font faces rather than leaving Satori on its fallback", async () => {
    fetchForMetadata.mockResolvedValue(healthy);

    await Image();

    const { fonts } = imageResponseCalls[0]!.options as {
      fonts?: { name: string; weight: number }[];
    };
    // Without these the card renders in Satori's bundled face, where a single
    // weight makes every `fontWeight` above inert.
    expect(fonts?.map((font) => font.weight).sort()).toEqual([
      400, 600, 700, 800,
    ]);
    expect(fonts?.every((font) => font.name === "Geist")).toBe(true);
  });

  it("still renders a card when there is no package to draw", async () => {
    fetchForMetadata.mockResolvedValue(null);

    await Image();

    // The fallback must reach Satori rather than throwing — a route that
    // errors here serves no image at all, which unfurls worse than the
    // "Status unavailable" card.
    expect(imageResponseCalls).toHaveLength(1);
  });
});
