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

vi.mock("@/lib/address-labels", async () => {
  const shared = await vi.importActual<
    typeof import("@/lib/address-labels-shared")
  >("@/lib/address-labels-shared");
  return {
    ...shared,
    importLabels: vi.fn().mockResolvedValue(undefined),
    replaceLabels: vi.fn().mockResolvedValue(undefined),
    getLabels: vi.fn().mockResolvedValue({}),
  };
});

vi.mock("@/lib/address-reports", async () => {
  const shared = await vi.importActual<
    typeof import("@/lib/address-reports-shared")
  >("@/lib/address-reports-shared");
  return {
    importReports: vi.fn().mockResolvedValue(undefined),
    replaceReports: vi.fn().mockResolvedValue(undefined),
    upgradeReports: shared.upgradeReports,
    MAX_BODY_LENGTH: shared.MAX_BODY_LENGTH,
    MAX_TITLE_LENGTH: shared.MAX_TITLE_LENGTH,
  };
});

import type { AddressEntry } from "@/lib/address-labels";
import { getLabels, importLabels, replaceLabels } from "@/lib/address-labels";
import { importReports, replaceReports } from "@/lib/address-reports";

import {
  emptyCounts,
  handleSnapshot,
  isEntriesMap,
  isGnosisSafeFormat,
  isSnapshot,
  mergeWithExisting,
  parseCsv,
  sanitizeAndFilter,
  splitCsvLine,
  stripArkhamProvenance,
} from "@/lib/address-labels/import";

const ADDR_A = "0x" + "a".repeat(40);
const ADDR_B = "0x" + "b".repeat(40);

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
  (getLabels as ReturnType<typeof vi.fn>).mockResolvedValue({});
  (importLabels as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (replaceLabels as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (importReports as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (replaceReports as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
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
      rows: [{ address: ADDR_A, name: "Alice", tags: [] }],
      hasTagsColumn: false,
    });
  });

  it("strips a leading UTF-8 BOM (Excel/Google Sheets export)", () => {
    const BOM = "﻿";
    const csv = `${BOM}address,name\n${ADDR_A},BOM Label`;
    const result = parseCsv(csv);
    expect(result).toMatchObject({
      hasTagsColumn: false,
      rows: [{ address: ADDR_A, name: "BOM Label" }],
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

  it("ignores the legacy chainId column (back-compat: no error, no scope)", () => {
    // Post-#332: chainId is accepted for back-compat with old Gnosis Safe
    // exports but ignored — every row imports as a single address-keyed
    // label.
    const csv = `address,name,chainId\n${ADDR_A},Alice,42220`;
    const result = parseCsv(csv);
    expect(result).toMatchObject({
      hasTagsColumn: false,
      rows: [{ address: ADDR_A, name: "Alice" }],
    });
  });

  it("ignores a non-numeric chainId without erroring (chainId is back-compat only)", () => {
    const csv = `address,name,chainId\n${ADDR_A},Alice,not-a-number`;
    const result = parseCsv(csv);
    expect(result).toMatchObject({
      rows: [{ address: ADDR_A, name: "Alice" }],
    });
  });

  it("returns last-wins rows for duplicate addresses in input order", () => {
    // parseCsv preserves both rows; downstream handleCsvText is responsible
    // for last-wins dedup.
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

describe("mergeWithExisting", () => {
  it("returns the incoming entry unchanged when no prior entry exists", () => {
    const incoming = { [ADDR_A]: entry({ name: "New" }) };
    const result = mergeWithExisting(incoming, {});
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
    const result = mergeWithExisting(incoming, { [ADDR_A]: prev });
    expect(result[ADDR_A]).toMatchObject({
      name: "New",
      tags: ["Whale"],
      notes: "carry me",
      isPublic: true,
    });
  });

  it("uses the incoming entry's tags rather than the prior entry's", () => {
    const prev = entry({ tags: ["OldTag1", "OldTag2"] });
    const incoming = { [ADDR_A]: entry({ tags: ["NewTag"] }) };
    const result = mergeWithExisting(incoming, { [ADDR_A]: prev });
    expect(result[ADDR_A]?.tags).toEqual(["NewTag"]);
  });

  it("strips arkham provenance from the merged result (legacy tag)", () => {
    const prev = entry({ tags: ["arkham"], source: "arkham" });
    const incoming = { [ADDR_A]: entry({ tags: ["arkham", "exchange"] }) };
    const result = mergeWithExisting(incoming, { [ADDR_A]: prev });
    expect(result[ADDR_A]).toMatchObject({
      tags: ["exchange"],
      source: undefined,
    });
  });

  it("looks up `prev` by lowercased address regardless of incoming key case", () => {
    const prev = entry({ notes: "lowercase-prev" });
    const upper = ADDR_A.toUpperCase().replace(/^0X/, "0x");
    const incoming = { [upper]: entry({ name: "Mixed-case import" }) };
    const result = mergeWithExisting(incoming, { [ADDR_A]: prev });
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

  it("returns true for an entry with no chainId (chainId is now optional)", () => {
    expect(isGnosisSafeFormat([{ address: ADDR_A, name: "Safe" }])).toBe(true);
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
    expect(
      isGnosisSafeFormat([{ address: ADDR_A, chainId: 42220, name: "Safe" }]),
    ).toBe(false);
  });

  it("returns false when an element is null", () => {
    expect(isGnosisSafeFormat([null])).toBe(false);
  });
});

describe("isSnapshot", () => {
  it("returns true for a payload with the new `addresses` key", () => {
    expect(isSnapshot({ addresses: { [ADDR_A]: entry() } })).toBe(true);
  });

  it("returns true for a payload with a legacy `chains` object", () => {
    expect(
      isSnapshot({
        chains: { "42220": {} },
      }),
    ).toBe(true);
  });

  it("returns true for a payload with a legacy `global` object", () => {
    expect(isSnapshot({ global: {} })).toBe(true);
  });

  it("returns true for a payload with only the new `reports` key", () => {
    // Reports-only snapshot — recognised so that a backup with reports but
    // no labels still routes to handleSnapshot (instead of falling through
    // to handleSimpleFormat and erroring out).
    expect(isSnapshot({ reports: {} })).toBe(true);
  });

  it("returns false when none of addresses/global/chains/reports are present", () => {
    expect(isSnapshot({ exportedAt: "2026-01-01T00:00:00Z" })).toBe(false);
  });

  it("returns false for null and primitives", () => {
    expect(isSnapshot(null)).toBe(false);
    expect(isSnapshot("snapshot")).toBe(false);
    expect(isSnapshot(42220)).toBe(false);
  });
});

describe("validateSnapshotReports", () => {
  const opts = { importerEmail: "alice@mentolabs.xyz" };

  it("returns an empty record when reports is undefined", async () => {
    const { validateSnapshotReports } =
      await import("@/lib/address-labels/import");
    expect(validateSnapshotReports(undefined, opts)).toEqual({ reports: {} });
  });

  it("returns an empty record when reports is an empty object", async () => {
    const { validateSnapshotReports } =
      await import("@/lib/address-labels/import");
    expect(validateSnapshotReports({}, opts)).toEqual({ reports: {} });
  });

  it("rejects non-object / array / null", async () => {
    const { validateSnapshotReports } =
      await import("@/lib/address-labels/import");
    expect(validateSnapshotReports("nope", opts)).toEqual({
      error: "Invalid reports map",
    });
    expect(validateSnapshotReports([], opts)).toEqual({
      error: "Invalid reports map",
    });
    expect(validateSnapshotReports(null, opts)).toEqual({
      error: "Invalid reports map",
    });
  });

  it("rejects empty body, missing body, oversized body, oversized title", async () => {
    const { validateSnapshotReports } =
      await import("@/lib/address-labels/import");
    expect(
      validateSnapshotReports({ [ADDR_A]: { body: "" } }, opts),
    ).toMatchObject({ error: expect.stringMatching(/empty or non-string/) });
    expect(
      validateSnapshotReports({ [ADDR_A]: { version: 1 } }, opts),
    ).toMatchObject({ error: expect.stringMatching(/empty or non-string/) });
    expect(
      validateSnapshotReports({ [ADDR_A]: { body: "x".repeat(50_001) } }, opts),
    ).toMatchObject({ error: expect.stringMatching(/exceeds 50000/) });
    expect(
      validateSnapshotReports(
        { [ADDR_A]: { body: "ok", title: "t".repeat(201) } },
        opts,
      ),
    ).toMatchObject({ error: expect.stringMatching(/exceeds 200/) });
  });

  it("re-stamps server-controlled metadata with importer's email + import source", async () => {
    // Cursor flagged that the verbatim-restore design let any session-
    // authenticated user forge another user's authorEmail/source/version
    // /timestamps via a crafted snapshot. User-uploaded import treats only `body`
    // and `title` as user-controlled — everything else is server-set.
    const { validateSnapshotReports } =
      await import("@/lib/address-labels/import");
    const result = validateSnapshotReports(
      {
        [ADDR_A]: {
          body: "investigation",
          title: "Counterparty",
          // These are the spoof-attempt fields — must be ignored:
          authorEmail: "victim@mentolabs.xyz",
          source: "claude",
          createdAt: "2020-01-01T00:00:00Z",
          updatedAt: "2020-01-01T00:00:00Z",
          version: 99,
        },
      },
      { importerEmail: "alice@mentolabs.xyz" },
    );
    if ("error" in result) throw new Error("expected ok");
    const r = result.reports[ADDR_A];
    expect(r.body).toBe("investigation");
    expect(r.title).toBe("Counterparty");
    expect(r.authorEmail).toBe("alice@mentolabs.xyz");
    expect(r.source).toBe("import");
    expect(r.version).toBe(1);
    // createdAt/updatedAt re-stamped to "now" — must not be the spoof value.
    expect(r.createdAt).not.toBe("2020-01-01T00:00:00Z");
    expect(r.updatedAt).not.toBe("2020-01-01T00:00:00Z");
    expect(typeof r.createdAt).toBe("string");
  });

  it("preserves report metadata for server-side Blob restores", async () => {
    const { validateSnapshotReports } =
      await import("@/lib/address-labels/import");
    const result = validateSnapshotReports(
      {
        [ADDR_A]: {
          body: "investigation",
          title: " Counterparty ",
          authorEmail: "analyst@mentolabs.xyz",
          source: "claude",
          createdAt: "2026-05-01T00:00:00Z",
          updatedAt: "2026-05-02T00:00:00Z",
          version: 7,
        },
      },
      {
        importerEmail: "restore@cron",
        reportMetadataMode: "preserve",
      },
    );
    if ("error" in result) throw new Error("expected ok");
    const r = result.reports[ADDR_A];
    expect(r.body).toBe("investigation");
    expect(r.title).toBe("Counterparty");
    expect(r.authorEmail).toBe("analyst@mentolabs.xyz");
    expect(r.source).toBe("claude");
    expect(r.createdAt).toBe("2026-05-01T00:00:00Z");
    expect(r.updatedAt).toBe("2026-05-02T00:00:00Z");
    expect(r.version).toBe(7);
  });

  it("rejects malformed authorEmail when preserving trusted report metadata", async () => {
    const { validateSnapshotReports } =
      await import("@/lib/address-labels/import");
    expect(
      validateSnapshotReports(
        {
          [ADDR_A]: {
            body: "investigation",
            authorEmail: "not-an-email",
          },
        },
        {
          importerEmail: "restore@cron",
          reportMetadataMode: "preserve",
        },
      ),
    ).toEqual({
      error: `Report for ${ADDR_A} has invalid authorEmail`,
    });
  });

  it("accepts valid input and lower-cases addresses", async () => {
    const { validateSnapshotReports } =
      await import("@/lib/address-labels/import");
    const upper = ADDR_A.toUpperCase().replace("0X", "0x");
    const result = validateSnapshotReports(
      {
        [upper]: { body: "ok", title: "T" },
      },
      opts,
    );
    if ("error" in result) throw new Error("expected ok");
    expect(Object.keys(result.reports)).toEqual([upper.toLowerCase()]);
    expect(result.reports[upper.toLowerCase()].body).toBe("ok");
  });

  it("trims and drops whitespace-only titles (matches sanitizeReportInput)", async () => {
    const { validateSnapshotReports } =
      await import("@/lib/address-labels/import");
    const result = validateSnapshotReports(
      { [ADDR_A]: { body: "ok", title: "   " } },
      opts,
    );
    if ("error" in result) throw new Error("expected ok");
    expect(result.reports[ADDR_A].title).toBeUndefined();
  });

  it("rejects non-string title (defensive: type coercion shouldn't happen)", async () => {
    const { validateSnapshotReports } =
      await import("@/lib/address-labels/import");
    expect(
      validateSnapshotReports({ [ADDR_A]: { body: "ok", title: 123 } }, opts),
    ).toMatchObject({
      error: expect.stringMatching(/title is not a string/),
    });
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
    expect(
      isEntriesMap({
        [ADDR_A]: { tags: ["Whale"], updatedAt: "2026-01-01" },
      }),
    ).toBe(true);
  });

  it("returns true for an empty object (no entries to validate)", () => {
    expect(isEntriesMap({})).toBe(true);
  });

  it("returns true for { name: '', tags: [] } — structural gate, not content filter", () => {
    expect(
      isEntriesMap({
        [ADDR_A]: { name: "", tags: [], updatedAt: "2026-01-01" },
      }),
    ).toBe(true);
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

describe("emptyCounts", () => {
  it("returns the zero state with the new flat `addresses` count", () => {
    expect(emptyCounts()).toEqual({ addresses: 0 });
  });
});

describe("handleSnapshot trusted restore mode", () => {
  it("replaces labels and reports while preserving trusted provenance metadata", async () => {
    const res = await handleSnapshot(
      {
        exportedAt: "2026-05-11T00:00:00.000Z",
        addresses: {
          [ADDR_A]: entry({
            name: "Arkham label",
            tags: ["exchange"],
            source: "arkham",
            createdAt: "2026-05-01T00:00:00.000Z",
          }),
        },
        reports: {
          [ADDR_B]: {
            body: "report",
            authorEmail: "analyst@mentolabs.xyz",
            source: "claude",
            createdAt: "2026-05-01T00:00:00.000Z",
            updatedAt: "2026-05-02T00:00:00.000Z",
            version: 3,
          },
        },
      },
      {
        importerEmail: "restore@cron",
        reportMetadataMode: "preserve",
        labelProvenanceMode: "preserve",
        writeMode: "replace",
      },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      imported: { addresses: 1, reports: 1 },
    });
    expect(getLabels).not.toHaveBeenCalled();
    expect(importLabels).not.toHaveBeenCalled();
    expect(importReports).not.toHaveBeenCalled();
    expect(replaceLabels).toHaveBeenCalledWith({
      [ADDR_A]: expect.objectContaining({
        source: "arkham",
        tags: ["exchange"],
      }),
    });
    expect(replaceReports).toHaveBeenCalledWith({
      [ADDR_B]: expect.objectContaining({
        authorEmail: "analyst@mentolabs.xyz",
        source: "claude",
        version: 3,
      }),
    });
  });

  it("clears present snapshot hashes when a trusted restore contains empty records", async () => {
    const res = await handleSnapshot(
      {
        exportedAt: "2026-05-11T00:00:00.000Z",
        addresses: {},
        reports: {},
      },
      {
        importerEmail: "restore@cron",
        reportMetadataMode: "preserve",
        labelProvenanceMode: "preserve",
        writeMode: "replace",
      },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      imported: { addresses: 0, reports: 0 },
    });
    expect(replaceLabels).toHaveBeenCalledWith({});
    expect(replaceReports).toHaveBeenCalledWith({});
    expect(importLabels).not.toHaveBeenCalled();
    expect(importReports).not.toHaveBeenCalled();
  });
});
