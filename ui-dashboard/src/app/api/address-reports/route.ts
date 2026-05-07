import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getAuthSession } from "@/auth";
import {
  findReport,
  getReportsIndex,
  upsertReport,
  deleteReport,
  sanitizeReportInput,
  type AddressReport,
} from "@/lib/address-reports";
import type { Scope } from "@/lib/address-labels-shared";
import { isValidAddress } from "@/lib/format";
import { NETWORKS } from "@/lib/networks";

// Only chainIds in NETWORKS can be scope targets — otherwise the strict-
// either-or Lua script's static KEYS list won't cover the orphan scope and a
// future cross-scope HDEL would silently miss it.
const SUPPORTED_CHAIN_IDS: ReadonlySet<number> = new Set(
  Object.values(NETWORKS).map((n) => n.chainId),
);

// HTTP body size guard for PUT — 50KB chars × 4-byte worst-case UTF-8 + JSON
// overhead = ~256KB. Mirrors the labels-import route's defense-in-depth check
// so an authenticated client can't force the server to read multi-MB payloads
// into memory before the in-handler `MAX_BODY_LENGTH` cap kicks in.
const MAX_PUT_BODY_BYTES = 256 * 1024;
// DELETE bodies are tiny (`{ scope, address }`) — keep the cap generous
// enough for headroom but well below the PUT cap.
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

  // Single-report read: ?address=0x...&scope=42220 — when scope is supplied,
  // the lookup filters to that scope OR global (mirrors the indicator's
  // chain → global fallback so the editor never loads a chain-specific
  // report a different chain row wouldn't have flagged).
  if (addressParam !== null) {
    if (!isValidAddress(addressParam)) {
      return NextResponse.json({ error: "Invalid address" }, { status: 400 });
    }
    const scopeParam = req.nextUrl.searchParams.get("scope");
    let preferredScope: Scope | undefined;
    if (scopeParam !== null) {
      const parsed = parseScope(
        scopeParam === "global" ? "global" : Number(scopeParam),
      );
      if (parsed === null) {
        return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
      }
      preferredScope = parsed;
    }
    try {
      const found = await findReport(addressParam, preferredScope);
      if (!found) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json({ ...found.report, scope: found.scope });
    } catch (err) {
      return serverError(err, "read");
    }
  }

  // Index read: addresses-only — the 📄 indicator needs nothing else, and
  // pulling full hash values just to drop the body would waste bandwidth on
  // every 60s poll.
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

  const {
    scope: scopeBody,
    address,
    body: reportBody,
    title,
  } = parsed as Record<string, unknown>;

  const scope = parseScope(scopeBody);
  if (scope === null) {
    return NextResponse.json(
      {
        error: "Invalid scope (must be 'global' or a positive integer chainId)",
      },
      { status: 400 },
    );
  }
  if (typeof address !== "string" || !isValidAddress(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  const sanitized = sanitizeReportInput({ body: reportBody, title });
  if (!sanitized.ok) {
    return NextResponse.json({ error: sanitized.error }, { status: 400 });
  }

  try {
    // authorEmail comes from the session — never trust the request body for
    // identity. Our Google Workspace gate (`@mentolabs.xyz` only) makes this
    // a meaningful audit trail without an extra users table.
    const authorEmail = session.user?.email ?? undefined;

    const saved: AddressReport = await upsertReport(scope, address, {
      body: sanitized.body,
      title: sanitized.title,
      authorEmail,
      source: "manual",
    });

    return NextResponse.json({ ok: true, report: { ...saved, scope } });
  } catch (err) {
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

  const { scope: scopeBody, address } = parsed as Record<string, unknown>;

  const scope = parseScope(scopeBody);
  if (scope === null) {
    return NextResponse.json(
      {
        error: "Invalid scope (must be 'global' or a positive integer chainId)",
      },
      { status: 400 },
    );
  }
  if (typeof address !== "string" || !isValidAddress(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  try {
    await deleteReport(scope, address);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return serverError(err, "delete");
  }
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function parseScope(scopeValue: unknown): Scope | null {
  if (scopeValue === "global") return "global";
  if (isPositiveInt(scopeValue)) {
    return SUPPORTED_CHAIN_IDS.has(scopeValue) ? scopeValue : null;
  }
  return null;
}

// Body-size guard. Two-step like the labels-import route: a fast Content-
// Length check rejects oversized requests before any read, then we read the
// body as text and re-check the actual byte length. Without the post-read
// check, a chunked / no-Content-Length client can stream an arbitrary-size
// JSON payload past `req.json()` before the in-handler 50KB validator runs.
//
// Returns either a 413 NextResponse OR the parsed JSON body. Callers narrow
// via `body instanceof NextResponse`.
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
