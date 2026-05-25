/**
 * Address-labels import handlers.
 *
 * The Next.js route at `/api/address-labels/import` is a thin HTTP wrapper
 * that authenticates, dispatches on content-type / payload shape, and
 * delegates the actual parsing + Redis writes to the named handlers below.
 *
 * Each `handle*` function returns a `NextResponse` so the route can simply
 * `return await handleX(...)`. Validation errors come back as 400, server
 * errors (Redis etc.) are captured to Sentry and returned as a generic 500.
 *
 * Labels are address-keyed only — no chain/global scope. The `chainId`
 * column in CSV imports and the `chainId` field in Gnosis Safe exports are
 * still accepted for backward compatibility but ignored — every entry
 * imports as a single address-keyed label. Old snapshots with `global` /
 * `chains` keys are read and merged into a flat address map.
 */
import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import {
  importLabels,
  getLabels,
  upgradeEntries,
  sanitizeEntry,
  type AddressEntry,
  type ImportedCounts,
} from "@/lib/address-labels";
import { isValidAddress } from "@/lib/format";
import {
  mergeWithExisting,
  sanitizeAndFilter,
  stripArkhamProvenance,
} from "./import-helpers";
import { isEntriesMap } from "./snapshot";
export {
  mergeWithExisting,
  sanitizeAndFilter,
  stripArkhamProvenance,
} from "./import-helpers";
export {
  handleSnapshot,
  isEntriesMap,
  isSnapshot,
  validateSnapshotReports,
} from "./snapshot";

export function emptyCounts(): ImportedCounts {
  return { addresses: 0 };
}

export async function handleGnosisSafe(
  body: Array<{ address: string; chainId?: string; name: string }>,
): Promise<NextResponse> {
  // Validate addresses + names; chainId is ignored (back-compat with the
  // pre-flat schema). If the same address appears more than once with
  // different names, last-wins.
  type ParsedEntry = { address: string; name: string };
  const parsed: ParsedEntry[] = [];
  for (const entry of body) {
    if (!isValidAddress(entry.address)) {
      return NextResponse.json(
        { error: `Invalid address: ${entry.address}` },
        { status: 400 },
      );
    }
    if (!entry.name.trim()) {
      return NextResponse.json(
        { error: `Entry with address ${entry.address} has an empty name` },
        { status: 400 },
      );
    }
    parsed.push({ address: entry.address, name: entry.name });
  }

  let existing: Record<string, AddressEntry>;
  try {
    existing = await getLabels();
  } catch (err) {
    return serverError(err);
  }

  const labels: Record<string, AddressEntry> = {};
  const now = new Date().toISOString();
  for (const { address, name } of parsed) {
    const lower = address.toLowerCase();
    const prev = existing[lower];
    labels[lower] = sanitizeEntry(
      stripArkhamProvenance({
        // Preserve existing metadata; only overwrite name and timestamp.
        ...prev,
        name,
        tags: prev?.tags ?? [],
        updatedAt: now,
      }),
    );
  }

  try {
    await importLabels(labels);
    return NextResponse.json({
      ok: true,
      imported: { addresses: Object.keys(labels).length },
    });
  } catch (err) {
    return serverError(err);
  }
}

export async function handleSimpleFormat(body: unknown): Promise<NextResponse> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      { error: "labels must be an object mapping address → entry" },
      { status: 400 },
    );
  }

  const { labels } = body as Record<string, unknown>;
  // The legacy simple format had `chainId` + `labels`; chainId is now
  // ignored. Accept the field (or not) but only validate `labels`.
  if (!isEntriesMap(labels)) {
    return NextResponse.json(
      { error: "labels must be an object mapping address → entry" },
      { status: 400 },
    );
  }

  try {
    let existing: Record<string, AddressEntry>;
    try {
      existing = await getLabels();
    } catch (err) {
      return serverError(err);
    }
    const upgraded = upgradeEntries(labels as Record<string, unknown>);
    const finalLabels = sanitizeAndFilter(
      mergeWithExisting(upgraded, existing),
    );
    await importLabels(finalLabels);
    return NextResponse.json({
      ok: true,
      imported: { addresses: Object.keys(finalLabels).length },
    });
  } catch (err) {
    return serverError(err);
  }
}

export function isGnosisSafeFormat(
  v: unknown,
): v is Array<{ address: string; chainId?: string; name: string }> {
  if (!Array.isArray(v)) return false;
  // An empty array is a valid (no-op) Gnosis Safe export — handle it as this
  // format so callers get 200 instead of a misleading parse error.
  if (v.length === 0) return true;
  return v.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).address === "string" &&
      typeof (entry as Record<string, unknown>).name === "string" &&
      // chainId is optional now; if present it must be a string for back-compat
      ((entry as Record<string, unknown>).chainId === undefined ||
        typeof (entry as Record<string, unknown>).chainId === "string"),
  );
}

function serverError(err: unknown): NextResponse {
  // Full error is in Sentry; return a generic string to the client.
  Sentry.captureException(err, { tags: { route: "address-labels/import" } });
  console.error("[address-labels/import]", err);
  return NextResponse.json({ error: "Import failed" }, { status: 500 });
}

// CSV import helpers

/**
 * Parse a CSV body and import the rows.
 *
 * Expected format (header row required):
 *   address,name,tags
 *   0x1234...,My Label,"Market Maker;Arbitrageur"
 *
 * Columns `tags` and `chainId` are optional. The `chainId` column is accepted
 * for backward compatibility but ignored — labels are no longer chain-scoped.
 * Tags are semicolon-delimited. Additional columns are ignored. Duplicate
 * addresses: last wins.
 */
async function handleCsvImport(req: NextRequest): Promise<NextResponse> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json(
      { error: "Failed to read CSV body" },
      { status: 400 },
    );
  }
  // Post-read size check for requests without Content-Length header
  if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) {
    return NextResponse.json(
      { error: "Request body too large (max 2MB)" },
      { status: 413 },
    );
  }
  return handleCsvText(text);
}

void handleCsvImport;

export async function handleCsvText(text: string): Promise<NextResponse> {
  const parsed = parseCsv(text);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { rows, hasTagsColumn } = parsed;
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, imported: emptyCounts() });
  }

  // Last-row-wins for duplicate addresses.
  const labels: Record<string, AddressEntry> = {};
  const now = new Date().toISOString();
  for (const { address, name, tags } of rows) {
    // Do NOT set isPublic here — the merge below preserves the existing value.
    // Forcing isPublic:true would silently un-private any previously private label.
    // Deduplicate tags case-insensitively in a single pass.
    const seenTags = new Set<string>();
    const deduplicatedTags = tags.flatMap((raw) => {
      const t = raw.trim();
      const key = t.toLowerCase();
      if (seenTags.has(key)) return [];
      seenTags.add(key);
      return [t];
    });
    const lower = address.toLowerCase();
    labels[lower] = {
      name,
      tags: deduplicatedTags,
      updatedAt: now,
    };
  }

  let existing: Record<string, AddressEntry>;
  try {
    existing = await getLabels();
  } catch (err) {
    return serverError(err);
  }

  const merged: Record<string, AddressEntry> = {};
  for (const [addr, entry] of Object.entries(labels)) {
    const prev = existing[addr.toLowerCase()];
    merged[addr] = sanitizeEntry(
      stripArkhamProvenance({
        ...prev,
        ...entry,
        // When CSV has no tags column, preserve existing tags instead of
        // overwriting with []
        tags: hasTagsColumn ? entry.tags : (prev?.tags ?? []),
      }),
    );
  }

  try {
    await importLabels(merged);
    return NextResponse.json({
      ok: true,
      imported: { addresses: Object.keys(merged).length },
    });
  } catch (err) {
    return serverError(err);
  }
}

type CsvRow = {
  address: string;
  name: string;
  tags: string[];
};

type CsvParseResult =
  | {
      rows: CsvRow[];
      /** True when the CSV contained a "tags" column; false = column absent */
      hasTagsColumn: boolean;
    }
  | { error: string };

/**
 * Minimal CSV parser. Supports quoted fields and UTF-8 BOM. Expects a header
 * row containing at least "address" and "name" columns (case-insensitive).
 * Optional "tags" column with semicolon-delimited values.
 * The legacy "chainId" column is parsed but ignored. Extra columns are ignored.
 *
 * Limitation: quoted fields containing embedded newlines (RFC 4180 §2.6) are
 * not supported. This is intentional — address/label data never spans lines
 * in practice, and supporting it would require a streaming tokenizer. If this
 * becomes necessary, replace with a proper CSV library (e.g. papaparse).
 */
export function parseCsv(text: string): CsvParseResult {
  // Strip UTF-8 BOM (U+FEFF) that Excel/Google Sheets prepend to CSV exports.
  const stripped = text.startsWith("﻿") ? text.slice(1) : text;
  const lines = stripped.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { rows: [], hasTagsColumn: false };

  // Parse header
  const headerParsed = splitCsvLine(lines[0]);
  if ("error" in headerParsed) {
    return { error: `Malformed CSV header: ${headerParsed.error}` };
  }
  const header = headerParsed.cols.map((h) => h.toLowerCase().trim());
  const addrIdx = header.indexOf("address");
  const nameIdx = header.indexOf("name");
  const tagsIdx = header.indexOf("tags");

  if (addrIdx === -1 || nameIdx === -1) {
    return {
      error:
        'CSV must have "address" and "name" columns (header row required). ' +
        `Got columns: ${header.join(", ")}`,
    };
  }

  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parsedLine = splitCsvLine(lines[i]);
    if ("error" in parsedLine) {
      return {
        error: `Malformed CSV on line ${i + 1}: ${parsedLine.error}`,
      };
    }
    const cols = parsedLine.cols;
    const address = cols[addrIdx]?.trim() ?? "";
    const name = cols[nameIdx]?.trim() ?? "";
    const tagsRaw = tagsIdx !== -1 ? (cols[tagsIdx]?.trim() ?? "") : "";
    const tags = tagsRaw
      ? tagsRaw.split(";").flatMap((t) => {
          const trimmed = t.trim();
          return trimmed ? [trimmed] : [];
        })
      : [];

    // Skip only fully empty rows. Half-empty rows are malformed input and
    // should fail loudly rather than silently disappearing from the import.
    if (!address && !name && tags.length === 0) continue;
    if (!address) {
      return {
        error: `Empty address on line ${i + 1}`,
      };
    }
    if (!isValidAddress(address)) {
      return {
        error: `Invalid address on line ${i + 1}: "${address}"`,
      };
    }
    // Relaxed validation: at least one of name or tags must be non-empty
    if (!name && tags.length === 0) {
      return {
        error: `Empty name for address ${address} on line ${i + 1}`,
      };
    }

    rows.push({ address, name, tags });
  }

  return { rows, hasTagsColumn: tagsIdx !== -1 };
}

/** Split a single CSV line respecting double-quoted fields. */
export function splitCsvLine(
  line: string,
): { cols: string[] } | { error: string } {
  const cols: string[] = [];
  let current = "";
  let inQuote = false;
  let atFieldStart = true;
  let justClosedQuote = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote) {
        if (line[i + 1] === '"') {
          // Escaped quote
          current += '"';
          i++;
        } else {
          inQuote = false;
          justClosedQuote = true;
        }
      } else {
        // Quotes are only valid at the start of a field.
        if (!atFieldStart) {
          return { error: "unexpected quote character" };
        }
        inQuote = true;
        justClosedQuote = false;
      }
    } else if (ch === "," && !inQuote) {
      cols.push(current);
      current = "";
      atFieldStart = true;
      justClosedQuote = false;
    } else {
      // After a closing quote, only a comma or EOL is valid.
      if (justClosedQuote) {
        return { error: "unexpected trailing characters after closing quote" };
      }
      current += ch;
      atFieldStart = false;
    }
  }

  if (inQuote) {
    return { error: "unterminated quoted field" };
  }

  cols.push(current);
  return { cols };
}
