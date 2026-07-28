import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { IntelEntityRecord } from "@/lib/intel-entities";

const { getAuthSession, getIntelEntityDirectorySource, notFound } = vi.hoisted(
  () => ({
    getAuthSession: vi.fn(),
    getIntelEntityDirectorySource: vi.fn(),
    notFound: vi.fn((): never => {
      throw new Error("NEXT_NOT_FOUND");
    }),
  }),
);

vi.mock("@/auth", () => ({
  ALLOWED_DOMAIN: "@mentolabs.xyz",
  getAuthSession,
}));
vi.mock("@/lib/intel-entities", () => ({
  getIntelEntityDirectorySource,
  INTEL_ENTITY_DIRECTORY_MAX_BYTES: 2 * 1024 * 1024,
  INTEL_ENTITY_DIRECTORY_MAX_RECORDS: 1_000,
}));
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
    getIntelEntityDirectorySource.mockResolvedValue({
      entities: {
        zeta: entity("zeta", "Zeta"),
        binance: entity("binance", "Binance"),
      },
      limited: false,
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
    expect(getIntelEntityDirectorySource).not.toHaveBeenCalled();
  });

  it("renders an explicit degraded state when the Redis read cap is exceeded", async () => {
    getIntelEntityDirectorySource.mockResolvedValue({
      entities: null,
      limited: true,
      reason: "payload-bytes",
    });

    const html = renderToStaticMarkup(await EntitiesPage());

    expect(html).toContain("Entity directory temporarily unavailable");
    expect(html).toContain("1,000 records or 2 MiB");
    expect(html).not.toContain('data-testid="entity-search"');
  });
});
