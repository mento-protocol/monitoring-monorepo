import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/auth";
import {
  handleGnosisSafe,
  handleSnapshot,
  handleSimpleFormat,
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

const invalidJsonResponse = () =>
  NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

const tooLargeResponse = () =>
  NextResponse.json(
    { error: "Request body too large (max 4MB)" },
    { status: 413 },
  );

async function readLimitedText(
  req: NextRequest,
): Promise<string | NextResponse> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return invalidJsonResponse();
  }
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BODY_BYTES) {
    return tooLargeResponse();
  }
  return text;
}

async function dispatchImportPayload(
  req: NextRequest,
  contentType: string,
  importerEmail: string,
): Promise<NextResponse> {
  const mediaType = normalizeMediaType(contentType);
  if (mediaType === "text/csv") {
    const text = await readLimitedText(req);
    return text instanceof NextResponse ? text : handleCsvText(text);
  }

  const parsed = await parseSniffedPayload(req, mediaType);
  if (parsed instanceof NextResponse) return parsed;
  if (parsed.kind === "csv") return handleCsvText(parsed.text);
  return dispatchJsonImport(parsed.body, importerEmail);
}

async function parseSniffedPayload(
  req: NextRequest,
  mediaType: string,
): Promise<
  NextResponse | { kind: "csv"; text: string } | { kind: "json"; body: unknown }
> {
  const text = await readLimitedText(req);
  if (text instanceof NextResponse) return text;

  const normalized = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const trimmed = normalized.trimStart();
  const isJsonContentType = mediaType === "application/json";
  if (
    !isJsonContentType &&
    trimmed &&
    !trimmed.startsWith("{") &&
    !trimmed.startsWith("[")
  ) {
    return { kind: "csv", text: normalized };
  }
  if (!trimmed) return invalidJsonResponse();

  try {
    return { kind: "json", body: JSON.parse(normalized) };
  } catch {
    return invalidJsonResponse();
  }
}

function normalizeMediaType(contentType: string): string {
  return contentType.split(";", 1)[0].trim().toLowerCase();
}

function dispatchJsonImport(
  body: unknown,
  importerEmail: string,
): Promise<NextResponse> | NextResponse {
  if (isGnosisSafeFormat(body)) return handleGnosisSafe(body);
  if (isSnapshot(body)) return handleSnapshot(body, { importerEmail });
  return handleSimpleFormat(body);
}

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
    return tooLargeResponse();
  }

  const contentType = req.headers.get("content-type") ?? "";

  // CSV import: explicit text/csv content-type → always CSV.
  // text/plain is NOT routed here directly — some environments send text/plain
  // for JSON files too. Instead, text/plain falls through to content sniffing
  // below, which checks whether the body starts with { or [.
  // Importer's email is server-controlled provenance for snapshot reports. The
  // fallback should not happen with our Google-only flow, but NextAuth's type
  // allows session.user.email to be null.
  return dispatchImportPayload(
    req,
    contentType,
    session.user?.email ?? "import@unknown",
  );
}
