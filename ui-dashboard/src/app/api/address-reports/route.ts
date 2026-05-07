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

  const tooLarge = guardBodySize(req, MAX_PUT_BODY_BYTES);
  if (tooLarge) return tooLarge;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    scope: scopeBody,
    address,
    body: reportBody,
    title,
  } = body as Record<string, unknown>;

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

  const tooLarge = guardBodySize(req, MAX_DELETE_BODY_BYTES);
  if (tooLarge) return tooLarge;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { scope: scopeBody, address } = body as Record<string, unknown>;

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

// Pre-read body-size guard. Trusts a present `content-length` header (Vercel /
// Next.js fastpath) — clients that omit it get the JSON-parse path's default
// limits. Returns a 413 response when over cap, or null when safe to proceed.
function guardBodySize(
  req: NextRequest,
  maxBytes: number,
): NextResponse | null {
  const header = req.headers.get("content-length");
  if (header === null) return null;
  const size = Number(header);
  if (!Number.isFinite(size) || size <= maxBytes) return null;
  return NextResponse.json(
    { error: "Request body too large" },
    { status: 413 },
  );
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
