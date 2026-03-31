import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/auth";
import {
  importLabels,
  getLabels,
  type AddressLabelEntry,
  type AddressLabelsSnapshot,
} from "@/lib/address-labels";
import { MAINNET_CHAIN_IDS } from "@/lib/types";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
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
    const trimmed = text.trimStart();
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
      return handleCsvText(text);
    }
    if (!trimmed) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Accept four formats:
  // 1. Snapshot format:    { exportedAt, chains: { chainId: { address: entry } } }
  // 2. Simple format:      { chainId, labels: { address: entry } }
  // 3. Gnosis Safe format: [{ address, chainId, name }]
  // 4. CSV format:         handled above via Content-Type or content sniffing
  if (isGnosisSafeFormat(body)) {
    const entries = body as Array<{
      address: string;
      chainId: string;
      name: string;
    }>;

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
      if (!/^0x[0-9a-fA-F]{40}$/.test(entry.address)) {
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
    // of overwriting — preserves category, notes, isPublic from prior entries.
    const existingByChain = new Map<
      number,
      Record<string, AddressLabelEntry>
    >();
    const distinctChainIds = [...new Set(parsed.map((e) => e.chainId))];
    try {
      for (const chainId of distinctChainIds) {
        existingByChain.set(chainId, await getLabels(chainId));
      }
    } catch (err) {
      return serverError(err);
    }

    const byChain = new Map<number, Record<string, AddressLabelEntry>>();
    for (const entry of parsed) {
      const { chainId, address, name } = entry;
      const existing = existingByChain.get(chainId) ?? {};
      const prev = existing[address.toLowerCase()];
      if (!byChain.has(chainId)) byChain.set(chainId, {});
      byChain.get(chainId)![address] = {
        // Preserve existing metadata; only overwrite label and timestamp.
        ...prev,
        label: name,
        updatedAt: new Date().toISOString(),
      };
    }

    try {
      for (const [chainId, labels] of byChain.entries()) {
        await importLabels(chainId, labels);
      }
      return NextResponse.json({ ok: true });
    } catch (err) {
      return serverError(err);
    }
  }

  if (isSnapshot(body)) {
    const chainEntries = Object.entries(body.chains);

    // Validate all chains upfront before writing anything
    for (const [key, labels] of chainEntries) {
      const n = Number(key);
      if (!Number.isInteger(n) || n <= 0) {
        return NextResponse.json(
          { error: `Invalid chainId key: ${key}` },
          { status: 400 },
        );
      }
      if (!isLabelsMap(labels)) {
        return NextResponse.json(
          { error: `Invalid labels map for chainId ${key}` },
          { status: 400 },
        );
      }
    }

    try {
      for (const [chainId, labels] of chainEntries) {
        await importLabels(Number(chainId), labels);
      }
      return NextResponse.json({ ok: true });
    } catch (err) {
      return serverError(err);
    }
  }

  const { chainId, labels } = body as Record<string, unknown>;
  if (
    typeof chainId !== "number" ||
    !Number.isInteger(chainId) ||
    chainId <= 0
  ) {
    return NextResponse.json({ error: "Invalid chainId" }, { status: 400 });
  }
  if (!isLabelsMap(labels)) {
    return NextResponse.json(
      { error: "labels must be an object mapping address → entry" },
      { status: 400 },
    );
  }

  try {
    await importLabels(chainId, labels);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return serverError(err);
  }
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

function isLabelsMap(v: unknown): v is Record<string, AddressLabelEntry> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as AddressLabelEntry).label === "string",
  );
}

function serverError(err: unknown): NextResponse {
  console.error("[address-labels/import]", err);
  const message = err instanceof Error ? err.message : "Internal server error";
  return NextResponse.json({ error: message }, { status: 500 });
}

// ---------------------------------------------------------------------------
// CSV import helpers
// ---------------------------------------------------------------------------

/**
 * Parse a CSV body and import into all configured mainnet chains.
 *
 * Expected format (header row required):
 *   address,name
 *   0x1234...,My Label
 *
 * Additional columns are ignored. Duplicate addresses are merged (last label
 * for an address wins). Chain defaults to Celo (42220) + Monad (143) mainnet.
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
  return handleCsvText(text);
}

async function handleCsvText(text: string): Promise<NextResponse> {
  const parsed = parseCsv(text);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { rows } = parsed;
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, imported: 0 });
  }

  // Build labels map — last row wins for duplicate addresses.
  const labels: Record<string, AddressLabelEntry> = {};
  const now = new Date().toISOString();
  for (const { address, name } of rows) {
    // Do NOT set isPublic here — the merge below preserves the existing value.
    // Forcing isPublic:true would silently un-private any previously private label.
    labels[address.toLowerCase()] = { label: name, updatedAt: now };
  }

  // Fetch existing labels to merge (preserve category, notes, isPublic).
  const existingByChain = new Map<number, Record<string, AddressLabelEntry>>();
  try {
    for (const chainId of MAINNET_CHAIN_IDS) {
      existingByChain.set(chainId, await getLabels(chainId));
    }
  } catch (err) {
    return serverError(err);
  }

  // Pre-compute all merged maps before any writes. Then fire all writes in
  // parallel via Promise.all — reduces (but does not eliminate) partial-write
  // risk compared to sequential writes. Note: Promise.all is NOT atomic; one
  // chain can succeed before another rejects. On failure, the caller should
  // retry — re-importing already-written chains is idempotent.
  const mergedByChain = new Map<number, Record<string, AddressLabelEntry>>();
  for (const chainId of MAINNET_CHAIN_IDS) {
    const existing = existingByChain.get(chainId) ?? {};
    const merged: Record<string, AddressLabelEntry> = {};
    for (const [addr, entry] of Object.entries(labels)) {
      const prev = existing[addr];
      merged[addr] = { ...prev, ...entry };
    }
    mergedByChain.set(chainId, merged);
  }

  try {
    await Promise.all(
      [...mergedByChain.entries()].map(([chainId, merged]) =>
        importLabels(chainId, merged),
      ),
    );
    return NextResponse.json({
      ok: true,
      imported: Object.keys(labels).length,
    });
  } catch (err) {
    return serverError(err);
  }
}

type CsvParseResult =
  | { rows: Array<{ address: string; name: string }> }
  | { error: string };

/**
 * Minimal CSV parser. Supports quoted fields and UTF-8 BOM. Expects a header
 * row containing at least "address" and "name" columns (case-insensitive).
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
  if (lines.length === 0) return { rows: [] };

  // Parse header
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().trim());
  const addrIdx = header.indexOf("address");
  const nameIdx = header.indexOf("name");

  if (addrIdx === -1 || nameIdx === -1) {
    return {
      error:
        'CSV must have "address" and "name" columns (header row required). ' +
        `Got columns: ${header.join(", ")}`,
    };
  }

  const rows: Array<{ address: string; name: string }> = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const address = cols[addrIdx]?.trim() ?? "";
    const name = cols[nameIdx]?.trim() ?? "";

    // Skip only fully empty rows. Half-empty rows are malformed input and
    // should fail loudly rather than silently disappearing from the import.
    if (!address && !name) continue;
    if (!address) {
      return {
        error: `Empty address on line ${i + 1}`,
      };
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return {
        error: `Invalid address on line ${i + 1}: "${address}"`,
      };
    }
    if (!name) {
      return {
        error: `Empty name for address ${address} on line ${i + 1}`,
      };
    }
    rows.push({ address, name });
  }

  return { rows };
}

/** Split a single CSV line respecting double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const cols: string[] = [];
  let current = "";
  let inQuote = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === "," && !inQuote) {
      cols.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cols.push(current);
  return cols;
}
