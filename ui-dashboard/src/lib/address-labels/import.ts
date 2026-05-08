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
  mergeEntries,
  upgradeEntries,
  sanitizeEntry,
  ARKHAM_TAG,
  type AddressEntry,
  type AddressLabelsSnapshot,
  type ImportedCounts,
} from "@/lib/address-labels";
import {
  importReports,
  MAX_BODY_LENGTH as MAX_REPORT_BODY_LENGTH,
  MAX_TITLE_LENGTH as MAX_REPORT_TITLE_LENGTH,
  type AddressReport,
} from "@/lib/address-reports";
import { isValidAddress } from "@/lib/format";

/**
 * User-controlled imports must never claim Arkham provenance — neither via
 * the new `source` field nor via the legacy `ARKHAM_TAG` tag sentinel that
 * `isArkhamSourced` still honours for backward compat. Without stripping
 * the tag, an authenticated user could import `tags: ["arkham"]` and have
 * the next refresh cron clobber their entry as a re-enrichment target.
 *
 * Re-importing an Arkham-enriched backup snapshot also resets provenance —
 * only the enrichment cron is allowed to set `source: "arkham"`.
 */
export function stripArkhamProvenance(entry: AddressEntry): AddressEntry {
  return {
    ...entry,
    source: undefined,
    tags: entry.tags.filter((t) => t !== ARKHAM_TAG),
  };
}

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

/**
 * Snapshot import options.
 *
 * `importerEmail` becomes the authoritative `authorEmail` on every restored
 * report — server-controlled metadata (`authorEmail`, `source`,
 * `createdAt`, `updatedAt`, `version`) is NOT trusted from the snapshot
 * payload. The verbatim restore that preserved the original snapshot's
 * provenance was a footgun: any session-authenticated user could POST a
 * crafted snapshot forging another user's authorship in the forensic
 * trail. A cron-driven restore-from-Blob endpoint (BACKLOG follow-up)
 * would be the right place to allow verbatim restore — gated by
 * cron-secret instead of session auth — but until that ships, the
 * import route always re-stamps.
 */
export type SnapshotImportOptions = {
  /** Email of the authenticated user driving the import. */
  importerEmail: string;
};

export async function handleSnapshot(
  body: AddressLabelsSnapshot,
  options: SnapshotImportOptions,
): Promise<NextResponse> {
  // Merge every entry from {addresses, global, chains} into a single
  // address-keyed map. Old backups carry `global` + `chains`; new backups
  // carry `addresses` (plus `global`/`chains` if the migration captured a
  // pre-existing flat hash alongside legacy scopes).
  //
  // When the same address appears in multiple sources, use `mergeEntries`
  // (union tags + updatedAt-newer-wins on scalars) instead of
  // `Object.assign`'s last-write-wins. Otherwise importing a backup that
  // captured both flat + legacy entries for the same address would silently
  // drop tags / notes / source from one of them.
  const merged: Record<string, AddressEntry> = {};
  function mergeIn(source: Record<string, AddressEntry>): void {
    for (const [addr, entry] of Object.entries(source)) {
      const lower = addr.toLowerCase();
      const prior = merged[lower];
      merged[lower] = prior ? mergeEntries(prior, entry) : entry;
    }
  }

  // Reject the mixed `{ labels, reports }` shape explicitly. The simple
  // format uses `labels` (not `addresses`), and `isSnapshot` now matches
  // anything with a `reports` key — so a legacy `{ labels, reports }`
  // payload routes here instead of to `handleSimpleFormat`. Without this
  // guard, the labels would be silently ignored (handleSnapshot only reads
  // `addresses`/`global`/`chains`) and the caller would see a 200 with
  // `imported.addresses = 0`. Surface the contradiction instead.
  if ((body as { labels?: unknown }).labels !== undefined) {
    return NextResponse.json(
      {
        error:
          "Snapshot must use `addresses` (not `labels`); a payload with both `labels` and `reports` is ambiguous — pick the simple format ({labels}) or the snapshot format ({addresses, reports}).",
      },
      { status: 400 },
    );
  }

  if (body.addresses !== undefined) {
    if (!isEntriesMap(body.addresses)) {
      return NextResponse.json(
        { error: "Invalid labels map for addresses" },
        { status: 400 },
      );
    }
    mergeIn(upgradeEntries(body.addresses as Record<string, unknown>));
  }
  if (body.global !== undefined) {
    if (!isEntriesMap(body.global)) {
      return NextResponse.json(
        { error: "Invalid labels map for legacy global scope" },
        { status: 400 },
      );
    }
    mergeIn(upgradeEntries(body.global as Record<string, unknown>));
  }
  if (body.chains !== undefined) {
    if (typeof body.chains !== "object" || body.chains === null) {
      return NextResponse.json(
        { error: "chains must be an object" },
        { status: 400 },
      );
    }
    for (const [key, labels] of Object.entries(body.chains)) {
      if (!isEntriesMap(labels)) {
        return NextResponse.json(
          { error: `Invalid labels map for legacy chain ${key}` },
          { status: 400 },
        );
      }
      mergeIn(upgradeEntries(labels as Record<string, unknown>));
    }
  }

  // Reports are decoupled from the labels merge — they have their own
  // Redis hash with no conflict semantics shared with labels.
  //
  // User-controlled content (body, title) is validated against the SAME
  // invariants the live editor enforces (`sanitizeReportInput`): non-empty
  // string body, body ≤ MAX_BODY_LENGTH, title ≤ MAX_TITLE_LENGTH.
  //
  // Server-controlled metadata (authorEmail, source, createdAt, updatedAt,
  // version) is NOT trusted from the payload — it's re-stamped with the
  // importer's email + `"import"` source + `now()` + version 1. Otherwise
  // any session-authenticated user could forge another user's authorship
  // in the forensic-report audit trail.
  const reportsValidation = validateSnapshotReports(body.reports, {
    importerEmail: options.importerEmail,
  });
  if ("error" in reportsValidation) {
    return NextResponse.json(
      { error: reportsValidation.error },
      { status: 400 },
    );
  }
  const reportsToImport: Record<string, AddressReport> =
    reportsValidation.reports;

  if (
    Object.keys(merged).length === 0 &&
    Object.keys(reportsToImport).length === 0
  ) {
    return NextResponse.json({ ok: true, imported: emptyCounts() });
  }

  try {
    let importedAddresses = 0;
    if (Object.keys(merged).length > 0) {
      let existing: Record<string, AddressEntry>;
      try {
        existing = await getLabels();
      } catch (err) {
        return serverError(err);
      }
      const finalLabels = sanitizeAndFilter(
        mergeWithExisting(merged, existing),
      );
      await importLabels(finalLabels);
      importedAddresses = Object.keys(finalLabels).length;
    }
    if (Object.keys(reportsToImport).length > 0) {
      await importReports(reportsToImport);
    }
    return NextResponse.json({
      ok: true,
      imported: { addresses: importedAddresses },
    });
  } catch (err) {
    return serverError(err);
  }
}

/**
 * Merge an import batch against the existing labels map so an address keeps
 * its prior `notes` + `isPublic` unless the import explicitly overwrites
 * them.
 *
 * Plain `{...prev, ...entry}` is broken here: `upgradeEntry` materialises
 * `notes: undefined` and `isPublic: undefined` for fields the import doesn't
 * set, which then clobber prev's real values during the spread (a present-
 * undefined key beats prev's "carry me"). Drop undefined keys from incoming
 * before the spread so prev's values survive.
 */
export function mergeWithExisting(
  incoming: Record<string, AddressEntry>,
  existing: Record<string, AddressEntry>,
): Record<string, AddressEntry> {
  const out: Record<string, AddressEntry> = {};
  for (const [addr, entry] of Object.entries(incoming)) {
    const prev = existing[addr.toLowerCase()];
    if (!prev) {
      out[addr] = stripArkhamProvenance(entry);
      continue;
    }
    const incomingDefined: Partial<AddressEntry> = {};
    for (const [k, v] of Object.entries(entry) as Array<
      [keyof AddressEntry, unknown]
    >) {
      if (v !== undefined) {
        (incomingDefined as Record<string, unknown>)[k] = v;
      }
    }
    out[addr] = stripArkhamProvenance({
      ...prev,
      ...incomingDefined,
      // The import's tags are authoritative when the format supports tags;
      // otherwise (simple + snapshot) incoming `entry.tags` already reflects
      // the caller's intent (they may be empty).
      tags: entry.tags,
    } as AddressEntry);
  }
  return out;
}

export async function handleSimpleFormat(body: unknown): Promise<NextResponse> {
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

// Sanitize (enforce limits) + filter empty entries. Lower-cases addresses so
// downstream writes are canonical.
export function sanitizeAndFilter(
  entries: Record<string, AddressEntry>,
): Record<string, AddressEntry> {
  return Object.fromEntries(
    Object.entries(entries)
      .map(([addr, e]) => [addr.toLowerCase(), sanitizeEntry(e)] as const)
      .filter(([, e]) => e.name !== "" || e.tags.length > 0),
  );
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

/**
 * Validate the `reports` half of a snapshot before restoring.
 *
 * Validates user-controlled fields (`body`, `title`) against the same
 * invariants the live editor enforces via `sanitizeReportInput`:
 * non-empty string body, body ≤ MAX_BODY_LENGTH, title ≤ MAX_TITLE_LENGTH.
 *
 * Re-stamps server-controlled fields (`authorEmail`, `source`, `createdAt`,
 * `updatedAt`, `version`) with the importer's email + `"import"` source +
 * `now()` + version 1. Trusting the snapshot's values would let any
 * session-authenticated user forge another user's authorship in the
 * forensic-report audit trail.
 *
 * Returns either `{ reports }` ready to write, or `{ error }` for the route
 * to surface as a 400.
 */
export function validateSnapshotReports(
  raw: unknown,
  options: { importerEmail: string },
): { reports: Record<string, AddressReport> } | { error: string } {
  if (raw === undefined) return { reports: {} };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "Invalid reports map" };
  }
  const now = new Date().toISOString();
  const result: Record<string, AddressReport> = {};
  for (const [addr, payload] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (!isValidAddress(addr)) {
      return { error: `Invalid report address: ${addr}` };
    }
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      return { error: `Invalid report payload for ${addr}` };
    }
    const p = payload as Record<string, unknown>;
    if (typeof p.body !== "string" || p.body.trim() === "") {
      return { error: `Report for ${addr} has an empty or non-string body` };
    }
    if (p.body.length > MAX_REPORT_BODY_LENGTH) {
      return {
        error: `Report for ${addr} body exceeds ${MAX_REPORT_BODY_LENGTH} characters`,
      };
    }
    let title: string | undefined;
    if (p.title !== undefined && p.title !== null) {
      if (typeof p.title !== "string") {
        return { error: `Report for ${addr} title is not a string` };
      }
      if (p.title.length > MAX_REPORT_TITLE_LENGTH) {
        return {
          error: `Report for ${addr} title exceeds ${MAX_REPORT_TITLE_LENGTH} characters`,
        };
      }
      // Match `sanitizeReportInput`: trim + drop if empty.
      const trimmed = p.title.trim();
      if (trimmed) title = trimmed;
    }
    // Re-stamp server-controlled metadata. Importer's email + `"import"`
    // source identifies the restore round; `version: 1` resets the
    // monotonic counter (any subsequent live edit will bump from 1 → 2).
    result[addr.toLowerCase()] = {
      body: p.body,
      ...(title ? { title } : {}),
      authorEmail: options.importerEmail,
      source: "import",
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
  }
  return { reports: result };
}

export function isSnapshot(v: unknown): v is AddressLabelsSnapshot {
  if (typeof v !== "object" || v === null) return false;
  // A snapshot has at least one of `addresses`, `global`, `chains`, `reports`.
  const obj = v as Record<string, unknown>;
  return (
    "addresses" in obj || "global" in obj || "chains" in obj || "reports" in obj
  );
}

/**
 * Validates that a value is a map of address → entry objects.
 * Accepts both v1 (label field) and v2 (name field) entry shapes.
 * Entries where both name/label is empty and tags is empty are excluded.
 */
export function isEntriesMap(v: unknown): v is Record<string, AddressEntry> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.entries(v as Record<string, unknown>).every(
    ([address, entry]) => {
      if (!isValidAddress(address)) return false;
      if (typeof entry !== "object" || entry === null) return false;
      const e = entry as Record<string, unknown>;
      // Accept v1 (label), v2 (name), or tag-only entries
      const hasName = typeof e.label === "string" || typeof e.name === "string";
      const hasTags = Array.isArray(e.tags) && e.tags.length > 0;
      return hasName || hasTags;
    },
  );
}

export function serverError(err: unknown): NextResponse {
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
export async function handleCsvImport(req: NextRequest): Promise<NextResponse> {
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
    // Deduplicate tags case-insensitively
    const seenTags = new Set<string>();
    const deduplicatedTags = tags
      .map((t) => t.trim())
      .filter((t) => {
        const key = t.toLowerCase();
        if (seenTags.has(key)) return false;
        seenTags.add(key);
        return true;
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
      ? tagsRaw
          .split(";")
          .map((t) => t.trim())
          .filter(Boolean)
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
