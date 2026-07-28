import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { IntelEntityRecord } from "@/lib/intel-entities";

const { getAuthSession, getAllIntelEntities, notFound } = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  getAllIntelEntities: vi.fn(),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/auth", () => ({
  ALLOWED_DOMAIN: "@mentolabs.xyz",
  getAuthSession,
}));
vi.mock("@/lib/intel-entities", () => ({ getAllIntelEntities }));
vi.mock("next/navigation", () => ({ notFound }));
vi.mock("../_components/entity-search", () => ({
  EntitySearch: ({
    items,
  }: {
    items: Array<{ slug: string; name: string }>;
  }) => (
    <div data-testid="entity-search">
      {items.map((item) => `${item.name}:${item.slug}`).join(",")}
    </div>
  ),
}));

import EntitiesPage from "../page";

function entity(slug: string, name: string): IntelEntityRecord {
  return {
    slug,
    fetchedAt: "2026-05-20T00:00:00Z",
    name,
    note: "",
    id: slug,
    customized: false,
    type: "cex",
    service: null,
    addresses: [],
    website: null,
    twitter: null,
    crunchbase: null,
    linkedin: null,
    populatedTags: null,
  };
}

describe("EntitiesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthSession.mockResolvedValue({
      user: { email: "analyst@mentolabs.xyz" },
    });
    getAllIntelEntities.mockResolvedValue({
      zeta: entity("zeta", "Zeta"),
      binance: entity("binance", "Binance"),
    });
  });

  it("renders the nested Address Book section with sorted enriched entities", async () => {
    const html = renderToStaticMarkup(await EntitiesPage());

    expect(html).toContain("Address Book");
    expect(html).toContain('href="/address-book/entities"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Binance:binance,Zeta:zeta");
  });

  it("fails closed when the server-side domain guard rejects the session", async () => {
    getAuthSession.mockResolvedValue({
      user: { email: "outsider@example.com" },
    });

    await expect(EntitiesPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getAllIntelEntities).not.toHaveBeenCalled();
  });
});
