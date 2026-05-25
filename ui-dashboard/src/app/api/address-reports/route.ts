import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getAuthSession } from "@/auth";
import {
  AddressReportNotFoundError,
  AddressReportVersionConflictError,
  findReport,
  getReportsIndex,
  upsertReport,
  deleteReport,
  sanitizeReportInput,
  type AddressReport,
} from "@/lib/address-reports";
import { isValidAddress } from "@/lib/format";

// HTTP body size guards. PUT carries up to 50KB of markdown plus JSON
// overhead — 256KB cap leaves headroom while bounding the worst case.
// DELETE bodies are tiny (`{ address }`).
const MAX_PUT_BODY_BYTES = 256 * 1024;
const MAX_DELETE_BODY_BYTES = 4 * 1024;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  const addressParam = req.nextUrl.searchParams.get("address");

  // Single-report read: ?address=0x...
  if (addressParam !== null) {
    if (!isValidAddress(addressParam)) {
      return NextResponse.json({ error: "Invalid address" }, { status: 400 });
    }
    try {
      const found = await findReport(addressParam);
      if (!found) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json(found);
    } catch (err) {
      return serverError(err, "read");
    }
  }

  // Index read: addresses-only — the 📄 indicator needs nothing else.
  try {
    const index = await getReportsIndex();
    return NextResponse.json(index);
  } catch (err) {
    return serverError(err, "read");
  }
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  const parsed = await readBoundedJson(req, MAX_PUT_BODY_BYTES);
  if (parsed instanceof NextResponse) return parsed;
  if (!isJsonObject(parsed)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    address,
    body: reportBody,
    title,
    baseVersion: rawBaseVersion,
  } = parsed as Record<string, unknown>;

  if (typeof address !== "string" || !isValidAddress(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  const sanitized = sanitizeReportInput({ body: reportBody, title });
  if (!sanitized.ok) {
    return NextResponse.json({ error: sanitized.error }, { status: 400 });
  }

  const parsedBaseVersion = parseBaseVersion(
    rawBaseVersion,
    req.headers.get("if-match"),
  );
  if (!parsedBaseVersion.ok) {
    return NextResponse.json(
      { error: parsedBaseVersion.error },
      { status: 400 },
    );
  }

  try {
    // authorEmail comes from the session — never trust the request body
    // for identity. Our Google Workspace gate (`@mentolabs.xyz` only)
    // makes this a meaningful audit trail without an extra users table.
    const authorEmail = session.user?.email ?? undefined;

    const saved: AddressReport = await upsertReport(address, {
      body: sanitized.body,
      title: sanitized.title,
      authorEmail,
      source: "manual",
      ...(parsedBaseVersion.baseVersion !== undefined
        ? { baseVersion: parsedBaseVersion.baseVersion }
        : {}),
    });

    return NextResponse.json({ ok: true, report: saved });
  } catch (err) {
    if (err instanceof AddressReportVersionConflictError) {
      return NextResponse.json(
        {
          error: "Report version conflict",
          existingVersion: err.existingVersion,
        },
        { status: 409 },
      );
    }
    return serverError(err, "save");
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  const parsed = await readBoundedJson(req, MAX_DELETE_BODY_BYTES);
  if (parsed instanceof NextResponse) return parsed;
  if (!isJsonObject(parsed)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { address, baseVersion: rawBaseVersion } = parsed;

  if (typeof address !== "string" || !isValidAddress(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  const parsedBaseVersion = parseBaseVersion(
    rawBaseVersion,
    req.headers.get("if-match"),
  );
  if (!parsedBaseVersion.ok) {
    return NextResponse.json(
      { error: parsedBaseVersion.error },
      { status: 400 },
    );
  }
  if (parsedBaseVersion.baseVersion === undefined) {
    return NextResponse.json(
      {
        error: "Report delete requires a baseVersion or If-Match precondition",
      },
      { status: 400 },
    );
  }

  try {
    await deleteReport(address, parsedBaseVersion.baseVersion);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AddressReportNotFoundError) {
      return NextResponse.json(
        { error: "Report no longer exists" },
        { status: 404 },
      );
    }
    if (err instanceof AddressReportVersionConflictError) {
      return NextResponse.json(
        {
          error: "Report version conflict",
          existingVersion: err.existingVersion,
        },
        { status: 409 },
      );
    }
    return serverError(err, "delete");
  }
}

// Body-size guard. Two-step like the labels-import route: a fast Content-
// Length check rejects oversized requests before any read, then we read the
// body as text and re-check the actual byte length. Without the post-read
// check, a chunked / no-Content-Length client can stream an arbitrary-size
// JSON payload past `req.json()` before the in-handler 50KB validator runs.
async function readBoundedJson(
  req: NextRequest,
  maxBytes: number,
): Promise<unknown | NextResponse> {
  const header = req.headers.get("content-length");
  if (header !== null) {
    const size = Number(header);
    if (Number.isFinite(size) && size > maxBytes) {
      return NextResponse.json(
        { error: "Request body too large" },
        { status: 413 },
      );
    }
  }
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return NextResponse.json(
      { error: "Request body too large" },
      { status: 413 },
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}

function parseBaseVersion(
  rawBaseVersion: unknown,
  ifMatch: string | null,
): { ok: true; baseVersion?: number } | { ok: false; error: string } {
  if (rawBaseVersion !== undefined && rawBaseVersion !== null) {
    if (!isValidBaseVersion(rawBaseVersion)) {
      return { ok: false, error: "baseVersion must be a positive integer" };
    }
    return { ok: true, baseVersion: rawBaseVersion };
  }

  if (ifMatch === null) return { ok: true };

  const trimmed = ifMatch.trim();
  const value = trimmed.startsWith("W/") ? trimmed.slice(2).trim() : trimmed;
  const unquoted =
    value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  const version = Number(unquoted);
  if (!isValidBaseVersion(version)) {
    return { ok: false, error: "If-Match must contain a positive integer" };
  }
  return { ok: true, baseVersion: version };
}

function isValidBaseVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serverError(
  err: unknown,
  op: "read" | "save" | "delete",
): NextResponse {
  Sentry.captureException(err, { tags: { route: "address-reports", op } });
  console.error("[address-reports]", op, err);
  return NextResponse.json(
    { error: `Failed to ${op} address report` },
    { status: 500 },
  );
}
