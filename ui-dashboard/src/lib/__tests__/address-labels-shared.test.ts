import { describe, expect, it } from "vitest";

import {
  upgradeEntry,
  mergeEntries,
  isArkhamSourced,
  isMiniPaySourced,
  derivePreservedSource,
  normalizeArkhamLegacy,
  withoutArkhamTags,
} from "@/lib/address-labels-shared";

describe("upgradeEntry", () => {
  it("preserves a legacy label when mixed-shape data has empty v2 name", () => {
    const entry = upgradeEntry({
      name: "",
      label: "Legacy Name",
      category: "DeFi",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    expect(entry).toMatchObject({
      name: "Legacy Name",
      tags: ["DeFi"],
      updatedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("keeps non-empty v2 name authoritative even when legacy label exists", () => {
    const entry = upgradeEntry({
      name: "Canonical Name",
      label: "Legacy Name",
      tags: ["Whale"],
      category: "DeFi",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    expect(entry).toMatchObject({
      name: "Canonical Name",
      tags: ["Whale"],
      updatedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("preserves tags on tag-only entries (no name, no label)", () => {
    // Regression: previously the fallback branch returned `tags: []`, silently
    // dropping the tag-only shape that `isEntriesMap` explicitly accepts. The
    // downstream `sanitizeAndFilter` then filtered the empty entry out and
    // the import returned 200 with 0 persisted.
    const entry = upgradeEntry({
      tags: ["Whale"],
      updatedAt: "2026-01-01T00:00:00Z",
    });

    expect(entry).toMatchObject({
      name: "",
      tags: ["Whale"],
      updatedAt: "2026-01-01T00:00:00Z",
    });
  });
});

describe("mergeEntries", () => {
  it("newer-wins on scalar fields, union on tags", () => {
    const prior = {
      name: "Old",
      tags: ["exchange"],
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const incoming = {
      name: "New",
      tags: ["dex"],
      updatedAt: "2026-06-01T00:00:00Z",
    };
    const merged = mergeEntries(prior, incoming);
    expect(merged.name).toBe("New");
    expect(merged.tags).toContain("exchange");
    expect(merged.tags).toContain("dex");
  });

  it("prior wins when its updatedAt is later", () => {
    const prior = {
      name: "PriorNewer",
      tags: ["a"],
      updatedAt: "2026-06-01T00:00:00Z",
    };
    const incoming = {
      name: "IncomingOlder",
      tags: ["b"],
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const merged = mergeEntries(prior, incoming);
    expect(merged.name).toBe("PriorNewer");
  });

  it("picks the earliest createdAt from either entry", () => {
    const prior = {
      name: "A",
      tags: [],
      updatedAt: "2026-06-01T00:00:00Z",
      createdAt: "2026-03-01T00:00:00Z",
    };
    const incoming = {
      name: "B",
      tags: [],
      updatedAt: "2026-01-01T00:00:00Z",
      createdAt: "2025-01-01T00:00:00Z",
    };
    const merged = mergeEntries(prior, incoming);
    expect(merged.createdAt).toBe("2025-01-01T00:00:00Z");
  });

  it("deduplicates tags case-insensitively", () => {
    const prior = {
      name: "A",
      tags: ["Exchange"],
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const incoming = {
      name: "B",
      tags: ["exchange"],
      updatedAt: "2026-06-01T00:00:00Z",
    };
    const merged = mergeEntries(prior, incoming);
    expect(merged.tags).toHaveLength(1);
  });
});

describe("isArkhamSourced", () => {
  it("true when source is 'arkham'", () => {
    expect(isArkhamSourced({ source: "arkham" })).toBe(true);
  });

  it("true when tags contain the legacy 'arkham' sentinel", () => {
    expect(isArkhamSourced({ tags: ["arkham"] })).toBe(true);
  });

  it("false when neither source nor legacy tag match", () => {
    expect(isArkhamSourced({ source: "manual", tags: ["exchange"] })).toBe(
      false,
    );
  });
});

describe("isMiniPaySourced", () => {
  it("true when source is 'minipay'", () => {
    expect(isMiniPaySourced({ source: "minipay" })).toBe(true);
  });

  it("false for other sources", () => {
    expect(isMiniPaySourced({ source: "arkham" })).toBe(false);
  });
});

describe("derivePreservedSource", () => {
  it("returns undefined for null prior", () => {
    expect(derivePreservedSource(null)).toBeUndefined();
  });

  it("returns 'arkham' when prior is arkham-sourced", () => {
    expect(derivePreservedSource({ source: "arkham" })).toBe("arkham");
  });

  it("returns 'minipay' when prior is minipay-sourced", () => {
    expect(derivePreservedSource({ source: "minipay" })).toBe("minipay");
  });

  it("returns undefined for manual entries", () => {
    expect(derivePreservedSource({ source: "manual" })).toBeUndefined();
  });
});

describe("normalizeArkhamLegacy", () => {
  it("passes through entries already in new shape (source=arkham)", () => {
    const entry = {
      name: "Test",
      tags: [],
      source: "arkham" as const,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(normalizeArkhamLegacy(entry)).toBe(entry);
  });

  it("upgrades legacy sentinel tag to source field", () => {
    const entry = {
      name: "Binance",
      tags: ["arkham", "exchange"],
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const result = normalizeArkhamLegacy(entry);
    expect(result.source).toBe("arkham");
    expect(result.tags).not.toContain("arkham");
    expect(result.tags).toContain("exchange");
  });
});

describe("withoutArkhamTags", () => {
  it("removes the arkham sentinel tag", () => {
    expect(withoutArkhamTags(["arkham", "exchange"])).toEqual(["exchange"]);
  });

  it("leaves non-arkham tags unchanged", () => {
    expect(withoutArkhamTags(["exchange", "cex"])).toEqual(["exchange", "cex"]);
  });
});
