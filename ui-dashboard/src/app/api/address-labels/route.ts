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
const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_RAW_TAGS = 100;

type PutLabelInput = {
  address: string;
  name: string;
  tags: string[];
  notes: string | undefined;
  isPublic: boolean;
};

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

  const payload = await readJsonObject(req);
  if (payload instanceof NextResponse) return payload;

  const input = normalizePutInput(payload);
  if (input instanceof NextResponse) return input;

  try {
    // Read only the prior entry, not the entire hash — `getLabel` does an
    // HGET vs HGETALL. Source is preserved across edits so user changes
    // don't silently demote an Arkham/MiniPay entry to `custom` and drop
    // it out of future refresh runs.
    const prior = await getLabel(input.address);
    const preservedSource = derivePreservedSource(prior);

    await upsertEntry(input.address, {
      name: input.name,
      tags: input.tags,
      notes: input.notes,
      isPublic: input.isPublic,
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

function normalizePutInput(
  payload: Record<string, unknown>,
): PutLabelInput | NextResponse {
  const { address, name, tags, notes, isPublic } = payload;

  if (typeof address !== "string" || !isValidAddress(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  const trimmedName = typeof name === "string" ? name.trim() : "";

  // DoS guards: cap input sizes.
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

  const tagsResult = normalizeTags(tags);
  if (!tagsResult.ok) return tagsResult.response;

  // Relaxed validation: at least one of name or normalized user tags must be
  // non-empty. Reserved source tags do not count as user-provided labels.
  if (!trimmedName && tagsResult.value.length === 0) {
    return NextResponse.json(
      { error: "At least one of name or tags must be provided" },
      { status: 400 },
    );
  }

  return {
    address,
    name: trimmedName,
    tags: tagsResult.value,
    notes: trimmedNotes,
    isPublic: isPublic === true,
  };
}

function normalizeTags(
  tags: unknown,
): { ok: true; value: string[] } | { ok: false; response: NextResponse } {
  if (Array.isArray(tags) && tags.length > MAX_RAW_TAGS) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "tags must have 100 raw items or fewer" },
        { status: 400 },
      ),
    };
  }

  const trimmedTags = Array.isArray(tags)
    ? tags.flatMap((tag) => {
        if (typeof tag !== "string") return [];
        const trimmed = tag.trim();
        return trimmed ? [trimmed] : [];
      })
    : [];

  const longTag = trimmedTags.find((tag) => tag.length > 50);
  if (longTag) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "each tag must be 50 characters or fewer" },
        { status: 400 },
      ),
    };
  }

  const seenTags = new Set<string>();
  const deduplicatedTags = trimmedTags.filter((tag) => {
    const key = tag.toLowerCase();
    if (RESERVED_SOURCE_TAGS.has(key)) return false;
    if (seenTags.has(key)) return false;
    seenTags.add(key);
    return true;
  });

  if (deduplicatedTags.length > 20) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "tags must have 20 items or fewer" },
        { status: 400 },
      ),
    };
  }

  return { ok: true, value: deduplicatedTags };
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  const payload = await readJsonObject(req);
  if (payload instanceof NextResponse) return payload;

  const { address } = payload;

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

async function readJsonObject(
  req: NextRequest,
): Promise<Record<string, unknown> | NextResponse> {
  const contentLengthHeader = req.headers.get("content-length");
  if (
    contentLengthHeader !== null &&
    Number(contentLengthHeader) > MAX_JSON_BODY_BYTES
  ) {
    return NextResponse.json(
      { error: "Request body too large (max 64KB)" },
      { status: 413 },
    );
  }

  try {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > MAX_JSON_BODY_BYTES) {
      return NextResponse.json(
        { error: "Request body too large (max 64KB)" },
        { status: 413 },
      );
    }
    const body = JSON.parse(text) as unknown;
    const payload = asObjectBody(body);
    return (
      payload ??
      NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
    );
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}

function asObjectBody(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
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
