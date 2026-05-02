/**
 * Per-handler unit tests for the address-labels import module.
 *
 * The route-level integration tests at
 * `app/api/address-labels/import/__tests__/route.test.ts` cover the HTTP
 * surface; these tests exercise the pure helpers + format detectors in
 * isolation so a regression in the parser or merge logic surfaces against the
 * smallest reproducer rather than a NextRequest round-trip.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the server-only `@/lib/address-labels` module so the import.ts file can
// be loaded without an Upstash Redis client. We re-export the real shared
// helpers (sanitizeEntry, upgradeEntries, ARKHAM_TAG, types) and stub out the
// server functions (importLabels, getAllLabels) — matching the pattern in
// route.test.ts. We import the real shared module and re-export its members
// instead of duplicating sanitizeEntry/upgradeEntry behaviour, so these tests
// assert against the production semantics of those helpers.
vi.mock("@/lib/address-labels", async () => {
  const shared = await vi.importActual<
    typeof import("@/lib/address-labels-shared")
  >("@/lib/address-labels-shared");
  return {
    ...shared,
    importLabels: vi.fn().mockResolvedValue(undefined),
    getLabels: vi.fn().mockResolvedValue({}),
    getAllLabels: vi.fn().mockResolvedValue({ global: {}, chains: {} }),
  };
});

import type { AddressEntry } from "@/lib/address-labels";
import { getAllLabels } from "@/lib/address-labels";

import {
  addCount,
  buildCrossScopeExisting,
  emptyCounts,
  isEntriesMap,
  isGnosisSafeFormat,
  isSnapshot,
  mergeWithCrossScope,
  parseCsv,
  sanitizeAndFilter,
  splitCsvLine,
  stripArkhamProvenance,
} from "@/lib/address-labels/import";

const ADDR_A = "0x" + "a".repeat(40);
const ADDR_B = "0x" + "b".repeat(40);
const ADDR_C = "0x" + "c".repeat(40);

function entry(overrides: Partial<AddressEntry> = {}): AddressEntry {
  return {
    name: "Test",
    tags: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getAllLabels as ReturnType<typeof vi.fn>).mockResolvedValue({
    global: {},
    chains: {},
  });
});

describe("splitCsvLine", () => {
  it("splits a comma-only line", () => {
    const result = splitCsvLine("a,b,c");
    expect(result).toEqual({ cols: ["a", "b", "c"] });
  });

  it("returns a single empty column for an empty string", () => {
    const result = splitCsvLine("");
    expect(result).toEqual({ cols: [""] });
  });

  it("treats trailing whitespace as part of the cell (no implicit trim)", () => {
    // splitCsvLine is the lowest-level tokenizer — trimming is the caller's
    // responsibility (parseCsv calls .trim() on each cell after split).
    const result = splitCsvLine("foo , bar  ");
    expect(result).toEqual({ cols: ["foo ", " bar  "] });
  });

  it("handles a quoted cell containing a comma", () => {
    const result = splitCsvLine('"hello, world",next');
    expect(result).toEqual({ cols: ["hello, world", "next"] });
  });

  it("unescapes a doubled quote inside a quoted cell", () => {
    const result = splitCsvLine('"she said ""hi"" today",ok');
    expect(result).toEqual({ cols: ['she said "hi" today', "ok"] });
  });

  it("rejects a stray quote in the middle of an unquoted field", () => {
    const result = splitCsvLine('foo,bar"baz');
    expect(result).toEqual({ error: "unexpected quote character" });
  });

  it("rejects content after a closing quote", () => {
    const result = splitCsvLine('"foo"junk,bar');
    expect(result).toEqual({
      error: "unexpected trailing characters after closing quote",
    });
  });

  it("rejects an unterminated quoted field", () => {
    const result = splitCsvLine('foo,"bar');
    expect(result).toEqual({ error: "unterminated quoted field" });
  });

  it("preserves an empty trailing column when the line ends with a comma", () => {
    const result = splitCsvLine("a,b,");
    expect(result).toEqual({ cols: ["a", "b", ""] });
  });
});

describe("parseCsv", () => {
  it("parses a header + a single data row", () => {
    const csv = `address,name\n${ADDR_A},Alice`;
    const result = parseCsv(csv);
    expect(result).toEqual({
      rows: [{ address: ADDR_A, name: "Alice", tags: [], scope: "global" }],
      hasTagsColumn: false,
    });
  });

  it("strips a leading UTF-8 BOM (Excel/Google Sheets export)", () => {
    const BOM = "\uFEFF";
    const csv = `${BOM}address,name\n${ADDR_A},BOM Label`;
    const result = parseCsv(csv);
    expect(result).toMatchObject({
      hasTagsColumn: false,
      rows: [{ address: ADDR_A, name: "BOM Label", scope: "global" }],
    });
  });

  it("returns an error when the required `address` column is missing", () => {
    const csv = `id,name\n${ADDR_A},Alice`;
    const result = parseCsv(csv);
    expect(result).toEqual({
      error: expect.stringMatching(/address.+name/i),
    });
  });

  it("returns an error when the required `name` column is missing", () => {
    const csv = `address,label\n${ADDR_A},Alice`;
    const result = parseCsv(csv);
    expect(result).toEqual({ error: expect.stringMatching(/name/i) });
  });

  it("rejects a non-numeric chainId column value", () => {
    const csv = `address,name,chainId\n${ADDR_A},Alice,not-a-number`;
    const result = parseCsv(csv);
    expect(result).toEqual({
      error: expect.stringMatching(/Invalid chainId .+ on line 2/),
    });
  });

  it("rejects a hex-encoded chainId column value", () => {
    const csv = `address,name,chainId\n${ADDR_A},Alice,0x1`;
    const result = parseCsv(csv);
    expect(result).toEqual({ error: expect.stringMatching(/Invalid chainId/) });
  });

  it("rejects a chainId not in NETWORKS", () => {
    // chainId 1 (Ethereum mainnet) isn't in our NETWORKS config — same guard
    // as the JSON paths so a stray import can't write a `labels:1` key the
    // strict-either-or HDEL list doesn't cover.
    const csv = `address,name,chainId\n${ADDR_A},Alice,1`;
    const result = parseCsv(csv);
    expect(result).toEqual({
      error: expect.stringMatching(/Unsupported chainId/),
    });
  });

  it("routes a row with a populated supported chainId to per-chain scope", () => {
    const csv = `address,name,chainId\n${ADDR_A},Alice,42220`;
    const result = parseCsv(csv);
    expect(result).toMatchObject({
      hasTagsColumn: false,
      rows: [{ address: ADDR_A, name: "Alice", scope: 42220 }],
    });
  });

  it("treats a blank chainId cell as global scope", () => {
    const csv = `address,name,chainId\n${ADDR_A},Alice,`;
    const result = parseCsv(csv);
    expect(result).toMatchObject({
      rows: [{ address: ADDR_A, name: "Alice", scope: "global" }],
    });
  });

  it("returns last-wins rows for duplicate (scope, address) pairs in input order", () => {
    // parseCsv is not responsible for deduplication; it returns rows as-is and
    // last-wins is enforced by the per-scope bucket overwrite in
    // handleCsvText. We verify here that parseCsv preserves both rows so the
    // downstream dedup contract can rely on input order.
    const csv = `address,name\n${ADDR_A},First\n${ADDR_A},Second`;
    const result = parseCsv(csv);
    expect(result).toMatchObject({
      rows: [
        { address: ADDR_A, name: "First" },
        { address: ADDR_A, name: "Second" },
      ],
    });
  });

  it("parses mixed quoted and unquoted cells in a single row", () => {
    const csv = `address,name,tags\n${ADDR_A},"Hello, World","Whale;Maker"`;
    const result = parseCsv(csv);
    expect(result).toMatchObject({
      hasTagsColumn: true,
      rows: [
        {
          address: ADDR_A,
          name: "Hello, World",
          tags: ["Whale", "Maker"],
        },
      ],
    });
  });

  it("unescapes doubled quotes inside a quoted cell", () => {
    const csv = `address,name\n${ADDR_A},"She said ""hi"" today"`;
    const result = parseCsv(csv);
    expect(result).toMatchObject({
      rows: [{ address: ADDR_A, name: 'She said "hi" today' }],
    });
  });

  it("flags hasTagsColumn=true when the CSV contains a tags header even if cells are blank", () => {
    const csv = `address,name,tags\n${ADDR_A},Alice,`;
    const result = parseCsv(csv);
    expect(result).toMatchObject({ hasTagsColumn: true });
  });

  it("returns an empty result for input with only whitespace", () => {
    const result = parseCsv("\n\n  \n");
    expect(result).toEqual({ rows: [], hasTagsColumn: false });
  });

  it("rejects a row with an empty address but a non-empty name", () => {
    const csv = `address,name\n,Alice`;
    const result = parseCsv(csv);
    expect(result).toEqual({
      error: expect.stringMatching(/Empty address on line 2/),
    });
  });

  it("rejects a row with an invalid address string", () => {
    const csv = `address,name\nnot-an-address,Alice`;
    const result = parseCsv(csv);
    expect(result).toEqual({
      error: expect.stringMatching(/Invalid address on line 2/),
    });
  });

  it("rejects a row with a valid address but empty name and no tags", () => {
    const csv = `address,name\n${ADDR_A},`;
    const result = parseCsv(csv);
    expect(result).toEqual({
      error: expect.stringMatching(/Empty name for address/),
    });
  });

  it("accepts a tag-only row (empty name with non-empty tags)", () => {
    const csv = `address,name,tags\n${ADDR_A},,Whale;Staker`;
    const result = parseCsv(csv);
    expect(result).toMatchObject({
      rows: [
        {
          address: ADDR_A,
          name: "",
          tags: ["Whale", "Staker"],
          scope: "global",
        },
      ],
    });
  });

  it("propagates a malformed CSV header error", () => {
    const csv = `address,"name\n${ADDR_A},Alice`;
    const result = parseCsv(csv);
    expect(result).toEqual({
      error: expect.stringMatching(/Malformed CSV header/),
    });
  });

  it("propagates a malformed CSV data row error", () => {
    const csv = `address,name\n${ADDR_A},"unterminated`;
    const result = parseCsv(csv);
    expect(result).toEqual({
      error: expect.stringMatching(/Malformed CSV on line 2.+unterminated/),
    });
  });

  it("supports CRLF line endings", () => {
    const csv = `address,name\r\n${ADDR_A},Alice\r\n`;
    const result = parseCsv(csv);
    expect(result).toMatchObject({
      rows: [{ address: ADDR_A, name: "Alice" }],
    });
  });
});

describe("stripArkhamProvenance", () => {
  it("removes the legacy `arkham` tag from tags", () => {
    const result = stripArkhamProvenance(
      entry({ tags: ["arkham", "exchange"] }),
    );
    expect(result.tags).toEqual(["exchange"]);
  });

  it("clears the `source` field", () => {
    const result = stripArkhamProvenance(entry({ source: "arkham" }));
    expect(result.source).toBeUndefined();
  });

  it("is a no-op for entries that have neither `source` nor the arkham tag", () => {
    const e = entry({ tags: ["whale", "maker"] });
    const result = stripArkhamProvenance(e);
    expect(result.tags).toEqual(["whale", "maker"]);
    expect(result.source).toBeUndefined();
    expect(result.name).toBe(e.name);
  });

  it("leaves non-arkham tags intact while clearing the sentinel", () => {
    const result = stripArkhamProvenance(
      entry({ tags: ["arkham", "Custom Tag", "another"] }),
    );
    expect(result.tags).toEqual(["Custom Tag", "another"]);
  });

  it("preserves notes/isPublic/createdAt while clearing provenance", () => {
    const result = stripArkhamProvenance(
      entry({
        tags: ["arkham"],
        source: "arkham",
        notes: "Important",
        isPublic: true,
        createdAt: "2025-01-01T00:00:00.000Z",
      }),
    );
    expect(result).toMatchObject({
      tags: [],
      source: undefined,
      notes: "Important",
      isPublic: true,
      createdAt: "2025-01-01T00:00:00.000Z",
    });
  });
});

describe("mergeWithCrossScope", () => {
  it("returns the incoming entry unchanged when no prior cross-scope entry exists", () => {
    const incoming = { [ADDR_A]: entry({ name: "New" }) };
    const result = mergeWithCrossScope(incoming, {});
    expect(result[ADDR_A]).toMatchObject({ name: "New" });
  });

  it("merges prior `notes` + `isPublic` into the incoming entry", () => {
    const prev = entry({
      name: "Old",
      tags: ["DeFi"],
      notes: "carry me",
      isPublic: true,
    });
    const incoming = { [ADDR_A]: entry({ name: "New", tags: ["Whale"] }) };
    const result = mergeWithCrossScope(incoming, { [ADDR_A]: prev });
    expect(result[ADDR_A]).toMatchObject({
      name: "New",
      // Incoming.tags is authoritative, prev.tags is dropped — the function
      // contract is "tags from import override prev.tags"
      tags: ["Whale"],
      notes: "carry me",
      isPublic: true,
    });
  });

  it("uses the incoming entry's tags rather than the prior entry's", () => {
    const prev = entry({ tags: ["OldTag1", "OldTag2"] });
    const incoming = { [ADDR_A]: entry({ tags: ["NewTag"] }) };
    const result = mergeWithCrossScope(incoming, { [ADDR_A]: prev });
    expect(result[ADDR_A]?.tags).toEqual(["NewTag"]);
  });

  it("strips arkham provenance from the merged result (legacy tag)", () => {
    const prev = entry({ tags: ["arkham"], source: "arkham" });
    const incoming = { [ADDR_A]: entry({ tags: ["arkham", "exchange"] }) };
    const result = mergeWithCrossScope(incoming, { [ADDR_A]: prev });
    expect(result[ADDR_A]).toMatchObject({
      tags: ["exchange"],
      source: undefined,
    });
  });

  it("looks up `prev` by lowercased address regardless of incoming key case", () => {
    // Cross-scope lookup is keyed by lowercase address — the incoming map's
    // own keys are not normalized here (handleCsvText/handleSimpleFormat do
    // that downstream via sanitizeAndFilter), but `prev` is found via
    // .toLowerCase().
    const prev = entry({ notes: "lowercase-prev" });
    const upper = ADDR_A.toUpperCase().replace(/^0X/, "0x");
    const incoming = { [upper]: entry({ name: "Mixed-case import" }) };
    const result = mergeWithCrossScope(incoming, { [ADDR_A]: prev });
    expect(result[upper]).toMatchObject({
      name: "Mixed-case import",
      notes: "lowercase-prev",
    });
  });
});

describe("sanitizeAndFilter", () => {
  it("lower-cases address keys", () => {
    const upper = ADDR_A.toUpperCase().replace(/^0X/, "0x");
    const result = sanitizeAndFilter({ [upper]: entry({ name: "Mixed" }) });
    expect(Object.keys(result)).toEqual([ADDR_A]);
  });

  it("drops entries that have empty name AND no tags after sanitization", () => {
    const result = sanitizeAndFilter({
      [ADDR_A]: entry({ name: "   ", tags: [] }),
      [ADDR_B]: entry({ name: "Valid" }),
    });
    expect(Object.keys(result)).toEqual([ADDR_B]);
  });

  it("keeps tag-only entries (empty name with non-empty tags)", () => {
    const result = sanitizeAndFilter({
      [ADDR_A]: entry({ name: "", tags: ["Whale"] }),
    });
    expect(result[ADDR_A]).toMatchObject({ name: "", tags: ["Whale"] });
  });

  it("applies sanitizeEntry — case-insensitive tag dedup + trimming", () => {
    // sanitizeEntry de-duplicates tags case-insensitively and trims
    // surrounding whitespace; sanitizeAndFilter wires it in at the entry
    // level.
    const result = sanitizeAndFilter({
      [ADDR_A]: entry({ tags: [" Whale ", "whale", "Whale"], name: "T" }),
    });
    expect(result[ADDR_A]?.tags).toEqual(["Whale"]);
  });

  it("trims and truncates the name via sanitizeEntry", () => {
    const result = sanitizeAndFilter({
      [ADDR_A]: entry({ name: "  spaced  " }),
    });
    expect(result[ADDR_A]?.name).toBe("spaced");
  });

  it("end-to-end: tag-only JSON survives upgradeEntries → sanitizeAndFilter", async () => {
    // Regression for the silent-drop bug Codex caught on this PR: tag-only
    // JSON imports satisfy `isEntriesMap` but used to round-trip to
    // `{ name: "", tags: [] }` because `upgradeEntry`'s fallback dropped
    // `normalizedTags`, so `sanitizeAndFilter` then filtered the entry out
    // and the import returned 200 with 0 persisted. With the fallback fix in
    // place, the same input must persist `{ name: "", tags: ["Whale"] }`.
    const { upgradeEntries } = await import("@/lib/address-labels-shared");
    const upgraded = upgradeEntries({
      [ADDR_A]: { tags: ["Whale"], updatedAt: "2026-01-01" },
    });
    const filtered = sanitizeAndFilter(upgraded);
    expect(filtered[ADDR_A]).toMatchObject({ name: "", tags: ["Whale"] });
  });
});

describe("isGnosisSafeFormat", () => {
  it("returns true for a valid Gnosis Safe array", () => {
    expect(
      isGnosisSafeFormat([{ address: ADDR_A, chainId: "42220", name: "Safe" }]),
    ).toBe(true);
  });

  it("returns true for an empty array (no-op import)", () => {
    expect(isGnosisSafeFormat([])).toBe(true);
  });

  it("returns false for a non-array value", () => {
    expect(isGnosisSafeFormat({ chainId: "42220" })).toBe(false);
  });

  it("returns false when an element is missing the `name` field", () => {
    expect(isGnosisSafeFormat([{ address: ADDR_A, chainId: "42220" }])).toBe(
      false,
    );
  });

  it("returns false when chainId is a number rather than a string", () => {
    // Gnosis Safe exports use a string `chainId` — mixing in a numeric
    // chainId is a different format and should fall through to other
    // detectors.
    expect(
      isGnosisSafeFormat([{ address: ADDR_A, chainId: 42220, name: "Safe" }]),
    ).toBe(false);
  });

  it("returns false when an element is null", () => {
    expect(isGnosisSafeFormat([null])).toBe(false);
  });
});

describe("isSnapshot", () => {
  it("returns true for a payload with a `chains` object", () => {
    expect(
      isSnapshot({
        chains: { "42220": {} },
      }),
    ).toBe(true);
  });

  it("returns true for an empty `chains` object", () => {
    // The route-level snapshot handler still validates per-chain shapes; the
    // detector only checks the presence + object-shape of `chains`.
    expect(isSnapshot({ chains: {} })).toBe(true);
  });

  it("returns false when `chains` is missing", () => {
    expect(isSnapshot({ exportedAt: "2026-01-01T00:00:00Z" })).toBe(false);
  });

  it("returns false when `chains` is an array, not an object", () => {
    expect(isSnapshot({ chains: [] })).toBe(false);
  });

  it("returns false for null and primitives", () => {
    expect(isSnapshot(null)).toBe(false);
    expect(isSnapshot("snapshot")).toBe(false);
    expect(isSnapshot(42220)).toBe(false);
  });
});

describe("isEntriesMap", () => {
  it("returns true for a v2-shape entry map", () => {
    expect(
      isEntriesMap({
        [ADDR_A]: { name: "Alice", tags: [], updatedAt: "2026-01-01" },
      }),
    ).toBe(true);
  });

  it("returns true for a v1-shape (label) entry map", () => {
    expect(
      isEntriesMap({
        [ADDR_A]: { label: "Alice", updatedAt: "2026-01-01" },
      }),
    ).toBe(true);
  });

  it("returns true for a tag-only entry (no name, but non-empty tags)", () => {
    // Tag-only entries flow through the full pipeline as `{ name: "", tags: [...] }`
    // — the downstream `sanitizeAndFilter` keeps them because tags.length > 0 satisfies
    // the "has signal" gate. Pinned end-to-end by the upgradeEntry fallback test in
    // `address-labels-shared.test.ts` and a sanitizeAndFilter test below.
    expect(
      isEntriesMap({
        [ADDR_A]: { tags: ["Whale"], updatedAt: "2026-01-01" },
      }),
    ).toBe(true);
  });

  it("returns true for an empty object (no entries to validate)", () => {
    expect(isEntriesMap({})).toBe(true);
  });

  it("returns false when a key is not a valid 0x address", () => {
    expect(
      isEntriesMap({ "not-an-address": { name: "Alice", tags: [] } }),
    ).toBe(false);
  });

  it("returns false for an entry that has neither name/label nor non-empty tags", () => {
    expect(
      isEntriesMap({
        [ADDR_A]: { notes: "no name field", updatedAt: "2026-01-01" },
      }),
    ).toBe(false);
  });

  it("returns false for null/undefined values", () => {
    expect(isEntriesMap(null)).toBe(false);
    expect(isEntriesMap(undefined)).toBe(false);
  });

  it("returns false for arrays (entry maps must be plain objects)", () => {
    expect(isEntriesMap([{ name: "Alice", tags: [], address: ADDR_A }])).toBe(
      false,
    );
  });

  it("returns false when an entry value is null", () => {
    expect(isEntriesMap({ [ADDR_A]: null })).toBe(false);
  });
});

describe("emptyCounts + addCount", () => {
  it("emptyCounts returns the zero state", () => {
    expect(emptyCounts()).toEqual({ global: 0, chains: {} });
  });

  it("addCount increments the global slot", () => {
    const counts = emptyCounts();
    addCount(counts, "global", 3);
    expect(counts).toEqual({ global: 3, chains: {} });
  });

  it("addCount creates the chain bucket on first use", () => {
    const counts = emptyCounts();
    addCount(counts, 42220, 5);
    expect(counts).toEqual({ global: 0, chains: { "42220": 5 } });
  });

  it("addCount accumulates within an existing chain bucket", () => {
    const counts = emptyCounts();
    addCount(counts, 42220, 2);
    addCount(counts, 42220, 3);
    expect(counts).toEqual({ global: 0, chains: { "42220": 5 } });
  });

  it("addCount with n=0 is a no-op (does not create the chain bucket)", () => {
    // Without the early-return, a chain that contributes zero rows would
    // still appear in the counts payload as `{ "143": 0 }` and confuse
    // dashboard readers that treat presence as "imported some".
    const counts = emptyCounts();
    addCount(counts, 143, 0);
    expect(counts).toEqual({ global: 0, chains: {} });
  });

  it("addCount keys chain buckets by the stringified chainId", () => {
    const counts = emptyCounts();
    addCount(counts, 42220, 1);
    expect(counts.chains).toEqual({ "42220": 1 });
  });
});

describe("buildCrossScopeExisting", () => {
  it("returns an empty object when no labels are seeded", async () => {
    (getAllLabels as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      global: {},
      chains: {},
    });
    const result = await buildCrossScopeExisting();
    expect(result).toEqual({});
  });

  it("flattens global + per-chain entries into a single map keyed by address", async () => {
    (getAllLabels as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      global: { [ADDR_A]: entry({ name: "Global A" }) },
      chains: {
        "42220": { [ADDR_B]: entry({ name: "Celo B" }) },
        "143": { [ADDR_C]: entry({ name: "Monad C" }) },
      },
    });
    const result = await buildCrossScopeExisting();
    expect(Object.keys(result).sort()).toEqual([ADDR_A, ADDR_B, ADDR_C].sort());
    expect(result[ADDR_A]).toMatchObject({ name: "Global A" });
    expect(result[ADDR_B]).toMatchObject({ name: "Celo B" });
    expect(result[ADDR_C]).toMatchObject({ name: "Monad C" });
  });

  it("prefers global over a chain-scoped entry for the same address (invariant violation fallback)", async () => {
    // Per strict either/or there's at most one scope per address; the helper
    // documents the deterministic fallback for hypothetical disk corruption:
    // global wins when present in `all.global`.
    (getAllLabels as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      global: { [ADDR_A]: entry({ name: "Global wins" }) },
      chains: {
        "42220": { [ADDR_A]: entry({ name: "Should be ignored" }) },
      },
    });
    const result = await buildCrossScopeExisting();
    expect(result[ADDR_A]).toMatchObject({ name: "Global wins" });
  });

  it("propagates a getAllLabels rejection (caller is responsible for serverError)", async () => {
    (getAllLabels as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Redis offline"),
    );
    await expect(buildCrossScopeExisting()).rejects.toThrow("Redis offline");
  });
});
