import { describe, expect, it } from "vitest";
import type { IntelEntityRecord } from "@/lib/intel-entities";
import { buildEntityDirectoryItems } from "./entity-directory";

function entity(
  overrides: Partial<IntelEntityRecord> & Pick<IntelEntityRecord, "slug">,
): IntelEntityRecord {
  return {
    fetchedAt: "2026-05-20T00:00:00Z",
    name: "",
    note: "",
    id: overrides.slug,
    customized: false,
    type: "",
    service: null,
    addresses: null,
    website: null,
    twitter: null,
    crunchbase: null,
    linkedin: null,
    populatedTags: null,
    ...overrides,
  };
}

describe("buildEntityDirectoryItems", () => {
  it("builds a deterministic, searchable directory with address counts", () => {
    const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const items = buildEntityDirectoryItems({
      zeta: entity({ slug: "zeta", name: "Zeta" }),
      binance: entity({
        slug: "binance",
        name: "Binance",
        type: "cex",
        addresses: [
          { address, chain: "ethereum" },
          { address: address.toUpperCase(), chain: "celo" },
        ],
        populatedTags: [
          {
            id: "centralized-exchange",
            label: "Centralized Exchange",
            rank: 1,
            excludeEntities: false,
            disablePage: false,
            tagParams: null,
          },
        ],
      }),
    });

    expect(items.map((item) => item.slug)).toEqual(["binance", "zeta"]);
    expect(items[0]).toMatchObject({
      name: "Binance",
      type: "cex",
      addressCount: 2,
      tags: ["Centralized Exchange"],
    });
    expect(items[0]?.searchText).toContain(address);
    expect(items[0]?.searchText).toContain("centralized exchange");
  });

  it("indexes legacy tag name and slug fields", () => {
    const legacyTags = [
      { name: "Exchange" },
      { slug: "protocol-treasury" },
    ] as unknown as IntelEntityRecord["populatedTags"];

    const item = buildEntityDirectoryItems({
      legacy: entity({
        slug: "legacy",
        name: "Legacy Entity",
        populatedTags: legacyTags,
      }),
    })[0];

    expect(item?.tags).toEqual(["Exchange", "protocol-treasury"]);
    expect(item?.searchText).toContain("exchange");
    expect(item?.searchText).toContain("protocol-treasury");
  });

  it("bounds the addresses serialized into client-side search text", () => {
    const addresses = Array.from({ length: 51 }, (_, index) => ({
      address: `0x${index.toString(16).padStart(40, "0")}`,
      chain: "ethereum",
    }));
    const item = buildEntityDirectoryItems({
      large: entity({ slug: "large", addresses }),
    })[0];

    expect(item?.addressCount).toBe(51);
    expect(item?.searchText).toContain(addresses[49]?.address);
    expect(item?.searchText).not.toContain(addresses[50]?.address);
  });

  it("falls back to the hash key when legacy records omit display fields", () => {
    const items = buildEntityDirectoryItems({
      "legacy-slug": entity({ slug: "", name: "" }),
    });

    expect(items[0]).toMatchObject({
      slug: "legacy-slug",
      name: "legacy-slug",
      type: null,
      addressCount: 0,
    });
  });
});
