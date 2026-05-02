import { describe, expect, it } from "vitest";

import { upgradeEntry } from "@/lib/address-labels-shared";

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
