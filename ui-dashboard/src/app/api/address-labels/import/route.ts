import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/auth";
import {
  handleGnosisSafe,
  handleSnapshot,
  handleSimpleFormat,
  handleCsvImport,
  handleCsvText,
  isGnosisSafeFormat,
  isSnapshot,
} from "@/lib/address-labels/import";

// Body size cap for import payloads. Bumped from 2MB → 4MB to fit a daily
// snapshot that now embeds forensic-report bodies (50KB cap × N reports +
// labels overhead). 4MB ≈ 80 max-size reports + labels — comfortable
// headroom against current usage (handful of investigations) and stays
// inside Vercel's 4.5MB serverless body limit. Larger backup restores should
// use `/api/address-labels/restore?pathname=...`, which pulls the private Blob
// snapshot server-side instead of uploading the JSON body through this route.
const MAX_IMPORT_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Thin HTTP wrapper for address-labels import. The actual parsing,
 * validation, and Redis writes live in `@/lib/address-labels/import`.
 *
 * Responsibilities:
 *   - auth gate (401 if no session)
 *   - 4MB body-size guard (Content-Length pre-check + post-read recheck)
 *   - content-type / sniff dispatch to the right `handle*` function
 *   - 400 for malformed JSON
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  // Body size guard: reject oversize payloads before reading into memory.
  const contentLengthHeader = req.headers.get("content-length");
  if (
    contentLengthHeader !== null &&
    Number(contentLengthHeader) > MAX_IMPORT_BODY_BYTES
  ) {
    return NextResponse.json(
      { error: "Request body too large (max 4MB)" },
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
    if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BODY_BYTES) {
      return NextResponse.json(
        { error: "Request body too large (max 4MB)" },
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
    // Importer's email is server-controlled provenance for any forensic
    // reports in the snapshot. Falls back to "import@unknown" only if the
    // session somehow lacks an email (the auth gate above guarantees a
    // session, but session.user.email can technically be null per the
    // NextAuth type — should not happen with our Google-only flow).
    const importerEmail = session.user?.email ?? "import@unknown";
    return handleSnapshot(body, { importerEmail });
  }

  return handleSimpleFormat(body);
}
