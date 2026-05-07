import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getAuthSession } from "@/auth";
import {
  getLabels,
  upsertEntry,
  deleteLabel,
  isArkhamSourced,
  isMiniPaySourced,
} from "@/lib/address-labels";
import { isValidAddress } from "@/lib/format";

export async function GET(): Promise<NextResponse> {
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  // Single endpoint: return every label as a flat address → entry map.
  // Labels are no longer chain-scoped, so there's no narrow-read or
  // chains-vs-global split.
  try {
    const labels = await getLabels();
    return NextResponse.json(labels);
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

  const { address, name, tags, notes, isPublic } = body as Record<
    string,
    unknown
  >;

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

  // DoS guards: cap input sizes
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

  // Deduplicate tags: case-insensitive, preserve first-occurrence casing.
  // Strip reserved server-provenance tags ("arkham", "minipay") — these
  // mark an entry as written by a server-side cron. Letting users set them
  // via the label editor would either clobber manually-curated entries on
  // the next cron run (arkham) or cause UI confusion where the badge says
  // "custom" but the Tags column shows "minipay" (minipay). Provenance is
  // authoritative through `source`, not tags.
  const RESERVED_SOURCE_TAGS = new Set(["arkham", "minipay"]);
  const seenTags = new Set<string>();
  const deduplicatedTags = parsedTags
    .map((t) => t.trim())
    .filter((t) => {
      const key = t.toLowerCase();
      if (RESERVED_SOURCE_TAGS.has(key)) return false;
      if (seenTags.has(key)) return false;
      seenTags.add(key);
      return true;
    });

  try {
    // Preserve server-controlled provenance across edits. A user editing
    // notes/tags on an Arkham-sourced row must NOT silently demote it to
    // `custom` — that would drop it out of future refresh cron runs and
    // lose the entity attribution. The user-supplied body never sets source
    // (no `source` in the destructure above); it's read here from the prior
    // entry only.
    const all = await getLabels();
    const addrLower = address.toLowerCase();
    const prior = all[addrLower];
    const preservedSource = !prior
      ? undefined
      : isArkhamSourced(prior)
        ? "arkham"
        : isMiniPaySourced(prior)
          ? "minipay"
          : undefined;

    await upsertEntry(address, {
      name: trimmedName,
      tags: deduplicatedTags,
      notes: trimmedNotes,
      isPublic: isPublic === true,
      ...(preservedSource ? { source: preservedSource } : {}),
      // Preserve first-write timestamp across edits;
      // upsertEntry defaults to `now` when this is undefined (new row).
      createdAt: prior?.createdAt,
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

  const { address } = body as Record<string, unknown>;

  if (typeof address !== "string" || !isValidAddress(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  try {
    await deleteLabel(address);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return serverError(err, "delete");
  }
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
