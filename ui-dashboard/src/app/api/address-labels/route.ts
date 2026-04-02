import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/auth";
import { getLabels, upsertEntry, deleteLabel } from "@/lib/address-labels";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const chainId = Number(req.nextUrl.searchParams.get("chainId"));
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return NextResponse.json({ error: "Invalid chainId" }, { status: 400 });
  }
  try {
    const session = await getAuthSession();
    const labels = await getLabels(chainId, {
      publicOnly: session === null,
    });
    return NextResponse.json(labels);
  } catch (err) {
    return serverError(err);
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

  const { chainId, address, name, tags, notes, isPublic } = body as Record<
    string,
    unknown
  >;

  if (!isPositiveInt(chainId)) {
    return NextResponse.json({ error: "Invalid chainId" }, { status: 400 });
  }
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
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

  try {
    await upsertEntry(chainId as number, address, {
      name: trimmedName,
      tags: parsedTags.map((t) => t.trim()),
      notes: typeof notes === "string" ? notes.trim() || undefined : undefined,
      isPublic: isPublic === true,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return serverError(err);
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

  const { chainId, address } = body as Record<string, unknown>;

  if (!isPositiveInt(chainId)) {
    return NextResponse.json({ error: "Invalid chainId" }, { status: 400 });
  }
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  try {
    await deleteLabel(chainId as number, address);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return serverError(err);
  }
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function serverError(err: unknown): NextResponse {
  console.error("[address-labels]", err);
  const message = err instanceof Error ? err.message : "Internal server error";
  return NextResponse.json({ error: message }, { status: 500 });
}
