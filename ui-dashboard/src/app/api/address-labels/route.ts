import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getAuthSession } from "@/auth";
import {
  getLabels,
  getAllLabels,
  upsertEntry,
  deleteLabel,
  type Scope,
} from "@/lib/address-labels";
import { isValidAddress } from "@/lib/format";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  const scopeParam = req.nextUrl.searchParams.get("scope");
  const chainIdParam = req.nextUrl.searchParams.get("chainId");

  // Narrow read: ?scope=global or ?chainId=42220
  if (scopeParam !== null || chainIdParam !== null) {
    const scope = parseScopeParam(scopeParam, chainIdParam);
    if (scope === null) {
      return NextResponse.json(
        { error: "Invalid scope or chainId" },
        { status: 400 },
      );
    }
    try {
      const labels = await getLabels(scope);
      return NextResponse.json(labels);
    } catch (err) {
      return serverError(err, "read");
    }
  }

  // Full read: { global, chains }. Session-gated — no public filter.
  try {
    return NextResponse.json(await getAllLabels());
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    scope: scopeBody,
    chainId: chainIdBody,
    address,
    name,
    tags,
    notes,
    isPublic,
  } = body as Record<string, unknown>;

  const scope = parseScope(scopeBody, chainIdBody);
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

  const trimmedName = typeof name === "string" ? name.trim() : "";
  const parsedTags = Array.isArray(tags)
    ? tags.filter((t): t is string => typeof t === "string" && t.trim() !== "")
    : [];

  // Relaxed validation: at least one of name or tags must be non-empty
  if (!trimmedName && parsedTags.length === 0) {
    return NextResponse.json(
      { error: "At least one of name or tags must be provided" },
      { status: 400 },
    );
  }

  // DoS guards: cap input sizes (#4)
  if (trimmedName.length > 200) {
    return NextResponse.json(
      { error: "name must be 200 characters or fewer" },
      { status: 400 },
    );
  }
  const trimmedNotes =
    typeof notes === "string" ? notes.trim() || undefined : undefined;
  if (trimmedNotes && trimmedNotes.length > 500) {
    return NextResponse.json(
      { error: "notes must be 500 characters or fewer" },
      { status: 400 },
    );
  }
  if (parsedTags.length > 20) {
    return NextResponse.json(
      { error: "tags must have 20 items or fewer" },
      { status: 400 },
    );
  }
  const longTag = parsedTags.find((t) => t.trim().length > 50);
  if (longTag) {
    return NextResponse.json(
      { error: "each tag must be 50 characters or fewer" },
      { status: 400 },
    );
  }

  // Deduplicate tags: case-insensitive, preserve first-occurrence casing (#6)
  const seenTags = new Set<string>();
  const deduplicatedTags = parsedTags
    .map((t) => t.trim())
    .filter((t) => {
      const key = t.toLowerCase();
      if (seenTags.has(key)) return false;
      seenTags.add(key);
      return true;
    });

  try {
    await upsertEntry(scope, address, {
      name: trimmedName,
      tags: deduplicatedTags,
      notes: trimmedNotes,
      isPublic: isPublic === true,
    });
    return NextResponse.json({ ok: true });
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    scope: scopeBody,
    chainId: chainIdBody,
    address,
  } = body as Record<string, unknown>;

  const scope = parseScope(scopeBody, chainIdBody);
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
    await deleteLabel(scope, address);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return serverError(err, "delete");
  }
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

// Accepts { scope } or legacy { chainId } alias; returns null on invalid.
function parseScope(scopeValue: unknown, chainIdValue: unknown): Scope | null {
  if (scopeValue === "global") return "global";
  if (isPositiveInt(scopeValue)) return scopeValue;
  if (scopeValue !== undefined) return null;
  // Legacy fallback: { chainId: number } (remove in a follow-up)
  if (isPositiveInt(chainIdValue)) return chainIdValue;
  return null;
}

// Narrow-read variant: scope as a string query param, chainId as numeric
// string. Strict decimal-only parse so `?chainId=1e3` doesn't silently
// resolve to chainId 1000 (matches the import-route guards).
function parseScopeParam(
  scopeParam: string | null,
  chainIdParam: string | null,
): Scope | null {
  if (scopeParam === "global") return "global";
  if (scopeParam !== null) return null;
  if (chainIdParam === null) return null;
  if (!/^\d+$/.test(chainIdParam)) return null;
  const n = Number(chainIdParam);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// op distinguishes which handler failed (read/save/delete) so the Sentry
// tag reflects the actual operation instead of a blanket "read" for every
// 500 across GET/PUT/DELETE.
function serverError(
  err: unknown,
  op: "read" | "save" | "delete",
): NextResponse {
  Sentry.captureException(err, { tags: { route: "address-labels", op } });
  console.error("[address-labels]", op, err);
  return NextResponse.json(
    { error: `Failed to ${op} address labels` },
    { status: 500 },
  );
}
