import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getAuthSession } from "@/auth";
import {
  importLabels,
  getLabels,
  upgradeEntries,
  sanitizeEntry,
  type AddressEntry,
  type AddressLabelsSnapshot,
  type Scope,
} from "@/lib/address-labels";
import { isValidAddress } from "@/lib/format";

type ImportedCounts = {
  global: number;
  chains: Record<string, number>;
};

function emptyCounts(): ImportedCounts {
  return { global: 0, chains: {} };
}

function addCount(counts: ImportedCounts, scope: Scope, n: number): void {
  if (n === 0) return;
  if (scope === "global") {
    counts.global += n;
  } else {
    counts.chains[String(scope)] = (counts.chains[String(scope)] ?? 0) + n;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  // Body size guard: reject payloads > 2MB before reading into memory (#5)
  const contentLengthHeader = req.headers.get("content-length");
  if (
    contentLengthHeader !== null &&
    Number(contentLengthHeader) > 2 * 1024 * 1024
  ) {
    return NextResponse.json(
      { error: "Request body too large (max 2MB)" },
      { status: 413 },
    );
  }

  const contentType = req.headers.get("content-type") ?? "";

  // CSV import: explicit text/csv content-type → always CSV.
  // text/plain is NOT routed here directly — some environments send text/plain
  // for JSON files too. Instead, text/plain falls through to content sniffing
  // below, which checks whether the body starts with { or [.
  if (contentType.startsWith("text/csv")) {
    return handleCsvImport(req);
  }

  let body: unknown;
  try {
    const text = await req.text();
    // Post-read size check for requests without Content-Length header
    if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) {
      return NextResponse.json(
        { error: "Request body too large (max 2MB)" },
        { status: 413 },
      );
    }
    // Strip UTF-8 BOM so BOM-prefixed JSON payloads keep working.
    const normalized = text.startsWith("\uFEFF") ? text.slice(1) : text;
    const trimmed = normalized.trimStart();
    // CSV sniffing: only attempt if the caller did NOT send application/json.
    // An empty body or non-JSON body with application/json should return 400,
    // not silently succeed as a CSV no-op. For other content-types (text/plain,
    // no content-type, etc.) we sniff: if the body doesn't start with { or [
    // it's likely CSV.
    const isJsonContentType = contentType.startsWith("application/json");
    if (
      !isJsonContentType &&
      trimmed &&
      !trimmed.startsWith("{") &&
      !trimmed.startsWith("[")
    ) {
      return handleCsvText(normalized);
    }
    if (!trimmed) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    body = JSON.parse(normalized);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Accept four formats:
  // 1. Snapshot format:    { exportedAt, global?: {...}, chains: { chainId: {...} } }
  // 2. Simple format:      { chainId, labels: { address: entry } }
  // 3. Gnosis Safe format: [{ address, chainId, name }]
  // 4. CSV format:         handled above via Content-Type or content sniffing
  if (isGnosisSafeFormat(body)) {
    return handleGnosisSafe(body);
  }

  if (isSnapshot(body)) {
    return handleSnapshot(body);
  }

  return handleSimpleFormat(body);
}

async function handleGnosisSafe(
  body: Array<{ address: string; chainId: string; name: string }>,
): Promise<NextResponse> {
  const entries = body;

  // Validate all entries upfront, then group by chainId.
  type ParsedEntry = { chainId: number; address: string; name: string };
  const parsed: ParsedEntry[] = [];
  for (const entry of entries) {
    // Strict decimal-only parse — reject "1e3", "0x1", and whitespace-padded
    // strings that Number() silently coerces to valid-looking chain IDs.
    // We intentionally do NOT trim: leading/trailing spaces are malformed input.
    if (!/^\d+$/.test(entry.chainId)) {
      return NextResponse.json(
        { error: `Invalid chainId: ${entry.chainId}` },
        { status: 400 },
      );
    }
    const chainId = parseInt(entry.chainId, 10);
    if (!Number.isInteger(chainId) || chainId <= 0) {
      return NextResponse.json(
        { error: `Invalid chainId: ${entry.chainId}` },
        { status: 400 },
      );
    }
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
    parsed.push({ chainId, address: entry.address, name: entry.name });
  }

  // Fetch existing labels for each distinct chainId so we can merge instead
  // of overwriting — preserves tags, notes, isPublic from prior entries.
  const existingByChain = new Map<number, Record<string, AddressEntry>>();
  const distinctChainIds = [...new Set(parsed.map((e) => e.chainId))];
  try {
    for (const chainId of distinctChainIds) {
      existingByChain.set(chainId, await getLabels(chainId));
    }
  } catch (err) {
    return serverError(err);
  }

  const byChain = new Map<number, Record<string, AddressEntry>>();
  for (const entry of parsed) {
    const { chainId, address, name } = entry;
    const normalizedAddress = address.toLowerCase();
    const existing = existingByChain.get(chainId) ?? {};
    const prev = existing[normalizedAddress];
    if (!byChain.has(chainId)) byChain.set(chainId, {});
    byChain.get(chainId)![normalizedAddress] = sanitizeEntry({
      // Preserve existing metadata; only overwrite name and timestamp.
      ...prev,
      name,
      tags: prev?.tags ?? [],
      updatedAt: new Date().toISOString(),
    });
  }

  try {
    const counts = emptyCounts();
    for (const [chainId, labels] of byChain.entries()) {
      addCount(counts, chainId, Object.keys(labels).length);
      await importLabels(chainId, labels);
    }
    return NextResponse.json({ ok: true, imported: counts });
  } catch (err) {
    return serverError(err);
  }
}

async function handleSnapshot(
  body: AddressLabelsSnapshot,
): Promise<NextResponse> {
  const chainEntries = Object.entries(body.chains);
  const globalEntries = body.global ?? {};

  // Validate chains upfront before writing anything.
  for (const [key, labels] of chainEntries) {
    const n = Number(key);
    if (!Number.isInteger(n) || n <= 0) {
      return NextResponse.json(
        { error: `Invalid chainId key: ${key}` },
        { status: 400 },
      );
    }
    if (!isEntriesMap(labels)) {
      return NextResponse.json(
        { error: `Invalid labels map for chainId ${key}` },
        { status: 400 },
      );
    }
  }

  // Validate global if present.
  if (body.global !== undefined && !isEntriesMap(body.global)) {
    return NextResponse.json(
      { error: "Invalid labels map for global scope" },
      { status: 400 },
    );
  }

  // Strict either/or: an address must not appear in both global AND a chain.
  // The alternative (silently letting the last write win) makes import order
  // load-bearing, which is surprising and error-prone.
  const globalAddresses = new Set(
    Object.keys(globalEntries).map((a) => a.toLowerCase()),
  );
  for (const [chainId, labels] of chainEntries) {
    for (const addr of Object.keys(labels as Record<string, unknown>)) {
      if (globalAddresses.has(addr.toLowerCase())) {
        return NextResponse.json(
          {
            error: `Address ${addr} appears in both global and chain ${chainId}; a label must be in exactly one scope`,
          },
          { status: 400 },
        );
      }
    }
  }

  try {
    const counts = emptyCounts();

    if (Object.keys(globalEntries).length > 0) {
      const upgraded = upgradeEntries(globalEntries as Record<string, unknown>);
      const filtered = sanitizeAndFilter(upgraded);
      addCount(counts, "global", Object.keys(filtered).length);
      await importLabels("global", filtered);
    }

    for (const [chainId, labels] of chainEntries) {
      const upgraded = upgradeEntries(labels as Record<string, unknown>);
      const filtered = sanitizeAndFilter(upgraded);
      addCount(counts, Number(chainId), Object.keys(filtered).length);
      await importLabels(Number(chainId), filtered);
    }
    return NextResponse.json({ ok: true, imported: counts });
  } catch (err) {
    return serverError(err);
  }
}

async function handleSimpleFormat(body: unknown): Promise<NextResponse> {
  const { chainId, labels } = body as Record<string, unknown>;
  if (
    typeof chainId !== "number" ||
    !Number.isInteger(chainId) ||
    chainId <= 0
  ) {
    return NextResponse.json({ error: "Invalid chainId" }, { status: 400 });
  }
  if (!isEntriesMap(labels)) {
    return NextResponse.json(
      { error: "labels must be an object mapping address → entry" },
      { status: 400 },
    );
  }

  try {
    const upgraded = upgradeEntries(labels as Record<string, unknown>);
    const filtered = sanitizeAndFilter(upgraded);
    await importLabels(chainId, filtered);
    const counts = emptyCounts();
    addCount(counts, chainId, Object.keys(filtered).length);
    return NextResponse.json({ ok: true, imported: counts });
  } catch (err) {
    return serverError(err);
  }
}

// Sanitize (enforce limits) + filter empty entries (#4, #7).
// Lower-cases addresses so downstream writes are canonical.
function sanitizeAndFilter(
  entries: Record<string, AddressEntry>,
): Record<string, AddressEntry> {
  return Object.fromEntries(
    Object.entries(entries)
      .map(([addr, e]) => [addr.toLowerCase(), sanitizeEntry(e)] as const)
      .filter(([, e]) => e.name !== "" || e.tags.length > 0),
  );
}

function isGnosisSafeFormat(
  v: unknown,
): v is Array<{ address: string; chainId: string; name: string }> {
  if (!Array.isArray(v)) return false;
  // An empty array is a valid (no-op) Gnosis Safe export — handle it as this
  // format so callers get 200 instead of a misleading "Invalid chainId" 400.
  if (v.length === 0) return true;
  return v.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).address === "string" &&
      typeof (entry as Record<string, unknown>).chainId === "string" &&
      typeof (entry as Record<string, unknown>).name === "string",
  );
}

function isSnapshot(v: unknown): v is AddressLabelsSnapshot {
  if (typeof v !== "object" || v === null || !("chains" in v)) return false;
  const { chains } = v as AddressLabelsSnapshot;
  return (
    typeof chains === "object" && chains !== null && !Array.isArray(chains)
  );
}

/**
 * Validates that a value is a map of address → entry objects.
 * Accepts both v1 (label field) and v2 (name field) entry shapes.
 * Entries where both name/label is empty and tags is empty are excluded (#7).
 */
function isEntriesMap(v: unknown): v is Record<string, AddressEntry> {
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

function serverError(err: unknown): NextResponse {
  // Full error is in Sentry; return a generic string to the client.
  Sentry.captureException(err, { tags: { route: "address-labels/import" } });
  console.error("[address-labels/import]", err);
  return NextResponse.json({ error: "Import failed" }, { status: 500 });
}

// CSV import helpers

/**
 * Parse a CSV body and route rows per-scope.
 *
 * Expected format (header row required):
 *   address,name,tags,chainId
 *   0x1234...,My Label,"Market Maker;Arbitrageur",
 *   0x5678...,Celo Rebalancer,,42220
 *
 * Columns `tags` and `chainId` are optional. When `chainId` is populated, the
 * row becomes a chain-specific label; when blank or the column is missing, the
 * row becomes a cross-chain (global) label. Tags are semicolon-delimited.
 * Additional columns are ignored. Duplicate (scope, address) pairs: last wins.
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

async function handleCsvText(text: string): Promise<NextResponse> {
  const parsed = parseCsv(text);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { rows, hasTagsColumn } = parsed;
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, imported: emptyCounts() });
  }

  // Group rows by scope. Within a scope, last row wins for duplicate addresses.
  const byScope = new Map<Scope, Record<string, AddressEntry>>();
  const now = new Date().toISOString();
  for (const { address, name, tags, scope } of rows) {
    // Do NOT set isPublic here — the merge below preserves the existing value.
    // Forcing isPublic:true would silently un-private any previously private label.
    // Deduplicate tags case-insensitively (#6)
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
    const bucket = byScope.get(scope) ?? {};
    bucket[lower] = {
      name,
      tags: deduplicatedTags,
      updatedAt: now,
    };
    byScope.set(scope, bucket);
  }

  // Fetch existing labels per scope for merge (preserve notes, isPublic).
  const existingByScope = new Map<Scope, Record<string, AddressEntry>>();
  try {
    for (const scope of byScope.keys()) {
      existingByScope.set(scope, await getLabels(scope));
    }
  } catch (err) {
    return serverError(err);
  }

  const mergedByScope = new Map<Scope, Record<string, AddressEntry>>();
  for (const [scope, labels] of byScope.entries()) {
    const existing = existingByScope.get(scope) ?? {};
    const merged: Record<string, AddressEntry> = {};
    for (const [addr, entry] of Object.entries(labels)) {
      const prev = existing[addr];
      merged[addr] = sanitizeEntry({
        ...prev,
        ...entry,
        // When CSV has no tags column, preserve existing tags instead of
        // overwriting with [] (#1)
        tags: hasTagsColumn ? entry.tags : (prev?.tags ?? []),
      });
    }
    mergedByScope.set(scope, merged);
  }

  try {
    const counts = emptyCounts();
    // Writes are sequential rather than parallel: `importLabels` enforces the
    // strict-either/or invariant by HDEL-ing from other scopes, so concurrent
    // writes across scopes for the same address could race. Sequential is
    // simpler and the import volume is small.
    for (const [scope, merged] of mergedByScope.entries()) {
      await importLabels(scope, merged);
      addCount(counts, scope, Object.keys(merged).length);
    }
    return NextResponse.json({ ok: true, imported: counts });
  } catch (err) {
    return serverError(err);
  }
}

type CsvRow = {
  address: string;
  name: string;
  tags: string[];
  scope: Scope;
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
 * Optional "chainId" column: populated → per-chain, blank/missing → global.
 * Extra columns are ignored.
 *
 * Limitation: quoted fields containing embedded newlines (RFC 4180 §2.6) are
 * not supported. This is intentional — address/label data never spans lines
 * in practice, and supporting it would require a streaming tokenizer. If this
 * becomes necessary, replace with a proper CSV library (e.g. papaparse).
 */
function parseCsv(text: string): CsvParseResult {
  // Strip UTF-8 BOM (U+FEFF) that Excel/Google Sheets prepend to CSV exports.
  const stripped = text.startsWith("\uFEFF") ? text.slice(1) : text;
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
  const chainIdIdx = header.indexOf("chainid");

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
    const chainIdRaw =
      chainIdIdx !== -1 ? (cols[chainIdIdx]?.trim() ?? "") : "";
    const tags = tagsRaw
      ? tagsRaw
          .split(";")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

    // Skip only fully empty rows. Half-empty rows are malformed input and
    // should fail loudly rather than silently disappearing from the import.
    if (!address && !name && tags.length === 0 && !chainIdRaw) continue;
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

    // chainId column: blank → global, populated → validated per-chain.
    let scope: Scope;
    if (!chainIdRaw) {
      scope = "global";
    } else {
      // Strict decimal-only parse — matches the Gnosis Safe format parser.
      if (!/^\d+$/.test(chainIdRaw)) {
        return {
          error: `Invalid chainId "${chainIdRaw}" on line ${i + 1}`,
        };
      }
      const chainId = parseInt(chainIdRaw, 10);
      if (!Number.isInteger(chainId) || chainId <= 0) {
        return {
          error: `Invalid chainId "${chainIdRaw}" on line ${i + 1}`,
        };
      }
      scope = chainId;
    }

    rows.push({ address, name, tags, scope });
  }

  return { rows, hasTagsColumn: tagsIdx !== -1 };
}

/** Split a single CSV line respecting double-quoted fields. */
function splitCsvLine(line: string): { cols: string[] } | { error: string } {
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
