import { beforeEach, describe, expect, it, vi } from "vitest";

const { permanentRedirect } = vi.hoisted(() => ({
  permanentRedirect: vi.fn((destination: string): never => {
    throw new Error(`NEXT_REDIRECT:${destination}`);
  }),
}));

vi.mock("next/navigation", () => ({ permanentRedirect }));

import LegacyEntitiesPage from "../page";
import LegacyEntityDetailPage from "../[slug]/page";

describe("legacy entity routes", () => {
  beforeEach(() => {
    permanentRedirect.mockClear();
  });

  it("redirects the directory and preserves repeated search parameters", async () => {
    await expect(
      LegacyEntitiesPage({
        searchParams: Promise.resolve({
          q: "binance",
          page: "2",
          tag: ["cex", "exchange"],
        }),
      }),
    ).rejects.toThrow(
      "NEXT_REDIRECT:/address-book/entities?q=binance&page=2&tag=cex&tag=exchange",
    );
  });

  it("redirects entity detail slugs to the nested route", async () => {
    await expect(
      LegacyEntityDetailPage({
        params: Promise.resolve({ slug: "crypto.com" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT:/address-book/entities/crypto.com");
  });
});
