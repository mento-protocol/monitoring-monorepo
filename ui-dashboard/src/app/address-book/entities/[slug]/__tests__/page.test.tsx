import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { IntelEntityRecord } from "@/lib/intel-entities";

const { getAuthSession, getIntelEntity, getIntelEntityCps, notFound } =
  vi.hoisted(() => ({
    getAuthSession: vi.fn(),
    getIntelEntity: vi.fn(),
    getIntelEntityCps: vi.fn(),
    notFound: vi.fn((): never => {
      throw new Error("NEXT_NOT_FOUND");
    }),
  }));

vi.mock("@/auth", () => ({
  ALLOWED_DOMAIN: "@mentolabs.xyz",
  getAuthSession,
}));
vi.mock("@/lib/intel-entities", () => ({ getIntelEntity }));
vi.mock("@/lib/intel-entity-cps", () => ({ getIntelEntityCps }));
vi.mock("next/navigation", () => ({ notFound }));

import EntityDetailPage from "../page";

const ADDRESS = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function entity(addresses: unknown): IntelEntityRecord {
  return {
    slug: "binance",
    fetchedAt: "2026-05-20T00:00:00Z",
    name: "Binance",
    note: "",
    id: "binance",
    customized: false,
    type: "cex",
    service: null,
    addresses,
    website: "https://www.binance.com",
    twitter: null,
    crunchbase: null,
    linkedin: null,
    populatedTags: null,
  };
}

describe("EntityDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthSession.mockResolvedValue({
      user: { email: "analyst@mentolabs.xyz" },
    });
    getIntelEntity.mockResolvedValue(
      entity([{ address: ADDRESS, chain: "ethereum" }]),
    );
    getIntelEntityCps.mockResolvedValue(null);
  });

  it("renders known EVM addresses as links into the Address Book", async () => {
    const html = renderToStaticMarkup(
      await EntityDetailPage({
        params: Promise.resolve({ slug: "binance" }),
      }),
    );

    expect(html).toContain("Known addresses");
    expect(html).toContain(`href="/address-book/${ADDRESS}"`);
    expect(html).toContain("ethereum");
    expect(html).toContain('href="/address-book/entities"');
  });

  it("renders non-EVM identifiers without a broken Address Book link", async () => {
    getIntelEntity.mockResolvedValue(
      entity([
        { address: "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE", chain: "tron" },
      ]),
    );

    const html = renderToStaticMarkup(
      await EntityDetailPage({
        params: Promise.resolve({ slug: "binance" }),
      }),
    );

    expect(html).toContain("TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE");
    expect(html).not.toContain(
      'href="/address-book/TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE"',
    );
  });

  it("fails closed when the entity does not exist", async () => {
    getIntelEntity.mockResolvedValue(null);

    await expect(
      EntityDetailPage({
        params: Promise.resolve({ slug: "missing" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getIntelEntityCps).not.toHaveBeenCalled();
  });
});
