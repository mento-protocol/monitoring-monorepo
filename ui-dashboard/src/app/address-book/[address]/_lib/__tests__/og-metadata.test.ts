import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/address-labels", () => ({ getLabel: vi.fn() }));

import { getLabel } from "@/lib/address-labels";
import { buildAddressOgMetadata } from "../og-metadata";

const mockGetLabel = vi.mocked(getLabel);
const ADDR = "0x" + "a".repeat(40);
const FALLBACK_TITLE = "Address — Address Book — Mento Analytics";

beforeEach(() => vi.clearAllMocks());

describe("buildAddressOgMetadata", () => {
  it("returns fallback metadata for invalid address", async () => {
    const meta = await buildAddressOgMetadata("not-an-address");
    expect(meta.title).toBe(FALLBACK_TITLE);
    expect(mockGetLabel).not.toHaveBeenCalled();
  });

  it("returns fallback metadata when label is null", async () => {
    mockGetLabel.mockResolvedValue(null);
    const meta = await buildAddressOgMetadata(ADDR);
    expect(meta.title).toBe(FALLBACK_TITLE);
  });

  it("returns fallback metadata when label is not public", async () => {
    mockGetLabel.mockResolvedValue({
      name: "Secret Wallet",
      tags: [],
      isPublic: false,
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const meta = await buildAddressOgMetadata(ADDR);
    expect(meta.title).toBe(FALLBACK_TITLE);
  });

  it("returns rich OG metadata for public labels", async () => {
    mockGetLabel.mockResolvedValue({
      name: "Treasury Wallet",
      tags: ["mento", "treasury"],
      isPublic: true,
      source: "manual",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const meta = await buildAddressOgMetadata(ADDR);
    expect(meta.title).toContain("Treasury Wallet");
    expect(meta.description ?? "").toContain("mento");
    expect(meta.description ?? "").toContain("manual");
    expect(meta.openGraph?.title).toContain("Treasury Wallet");
  });

  it("handles malformed percent-encoding gracefully", async () => {
    // decodeURIComponent('%zz') throws URIError — should fallback, not throw
    const meta = await buildAddressOgMetadata("%zz");
    expect(meta.title).toBe(FALLBACK_TITLE);
  });
});
