import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getAuthSession } from "@/auth";
import {
  ARKHAM_TAG,
  MINIPAY_SOURCE,
  derivePreservedSource,
  deleteLabel,
  getLabel,
  getLabels,
  upsertEntry,
} from "@/lib/address-labels";
import { isValidAddress } from "@/lib/format";

// Reserved server-provenance tag names. Letting users set these via the
// editor either clobbers manually-curated entries on the next cron run
// (arkham) or causes UI confusion where the badge says "custom" but the
// Tags column shows "minipay". Provenance lives on `source`, not tags.
const RESERVED_SOURCE_TAGS = new Set<string>([ARKHAM_TAG, MINIPAY_SOURCE]);

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
  const trimmedTags = Array.isArray(tags)
    ? tags.flatMap((t) => {
        if (typeof t !== "string") return [];
        const trimmed = t.trim();
        return trimmed ? [trimmed] : [];
      })
    : [];

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
  const longTag = trimmedTags.find((t) => t.length > 50);
  if (longTag) {
    return NextResponse.json(
      { error: "each tag must be 50 characters or fewer" },
      { status: 400 },
    );
  }

  // Deduplicate tags case-insensitively (preserve first-occurrence casing)
  // and strip reserved server-provenance tags.
  const seenTags = new Set<string>();
  const deduplicatedTags = trimmedTags.filter((t) => {
    const key = t.toLowerCase();
    if (RESERVED_SOURCE_TAGS.has(key)) return false;
    if (seenTags.has(key)) return false;
    seenTags.add(key);
    return true;
  });

  if (deduplicatedTags.length > 20) {
    return NextResponse.json(
      { error: "tags must have 20 items or fewer" },
      { status: 400 },
    );
  }

  // Relaxed validation: at least one of name or normalized user tags must be
  // non-empty. Reserved source tags do not count as user-provided labels.
  if (!trimmedName && deduplicatedTags.length === 0) {
    return NextResponse.json(
      { error: "At least one of name or tags must be provided" },
      { status: 400 },
    );
  }

  try {
    // Read only the prior entry, not the entire hash — `getLabel` does an
    // HGET vs HGETALL. Source is preserved across edits so user changes
    // don't silently demote an Arkham/MiniPay entry to `custom` and drop
    // it out of future refresh runs.
    const prior = await getLabel(address);
    const preservedSource = derivePreservedSource(prior);

    await upsertEntry(address, {
      name: trimmedName,
      tags: deduplicatedTags,
      notes: trimmedNotes,
      isPublic: isPublic === true,
      ...(preservedSource ? { source: preservedSource } : {}),
      // Preserve first-write timestamp; `upsertEntry` defaults to `now`
      // when undefined (new row).
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
