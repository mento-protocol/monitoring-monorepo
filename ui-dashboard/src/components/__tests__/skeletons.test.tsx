import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ChartSkeleton,
  PageShellSkeleton,
  TableSkeleton,
  TileGridSkeleton,
} from "@/components/skeletons";

describe("TableSkeleton", () => {
  it("renders the requested row and column count", () => {
    const html = renderToStaticMarkup(<TableSkeleton rows={3} cols={4} />);
    // 1 header row (4 cells) + 3 data rows (4 cells each) = 16 shimmer divs
    const shimmerCount = (html.match(/animate-pulse/g) ?? []).length;
    expect(shimmerCount).toBe(4 + 3 * 4);
  });

  it("falls back to default row/col counts when props omitted", () => {
    const html = renderToStaticMarkup(<TableSkeleton />);
    // defaults: rows=8, cols=5 → 5 + 8*5 = 45
    const shimmerCount = (html.match(/animate-pulse/g) ?? []).length;
    expect(shimmerCount).toBe(45);
  });

  it('advertises itself to assistive tech via role="status"', () => {
    const html = renderToStaticMarkup(<TableSkeleton rows={1} cols={1} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Loading…");
  });
});

describe("TileGridSkeleton", () => {
  it("renders the requested tile count", () => {
    const html = renderToStaticMarkup(<TileGridSkeleton count={6} />);
    // Each tile has 3 shimmer divs (label + value + subtitle)
    const shimmerCount = (html.match(/animate-pulse/g) ?? []).length;
    expect(shimmerCount).toBe(6 * 3);
  });

  it("defaults to 4 tiles", () => {
    const html = renderToStaticMarkup(<TileGridSkeleton />);
    const shimmerCount = (html.match(/animate-pulse/g) ?? []).length;
    expect(shimmerCount).toBe(4 * 3);
  });
});

describe("ChartSkeleton", () => {
  it("applies the requested aspect ratio inline", () => {
    const html = renderToStaticMarkup(<ChartSkeleton aspect="4 / 3" />);
    expect(html).toContain("aspect-ratio:4 / 3");
  });

  it('defaults to 16:9 and exposes role="status"', () => {
    const html = renderToStaticMarkup(<ChartSkeleton />);
    expect(html).toContain("aspect-ratio:16 / 9");
    expect(html).toContain('role="status"');
  });
});

describe("PageShellSkeleton", () => {
  it("renders a header band, a tile grid, and a table skeleton together", () => {
    const html = renderToStaticMarkup(<PageShellSkeleton />);
    // Header bar (1) + 4 tiles × 3 shimmer + table (5 header cells + 8*5 body cells = 45)
    const shimmerCount = (html.match(/animate-pulse/g) ?? []).length;
    expect(shimmerCount).toBe(1 + 4 * 3 + 45);
  });
});
