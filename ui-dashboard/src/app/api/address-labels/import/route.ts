import { NextRequest, NextResponse } from "next/server";
import {
  importLabels,
  type AddressLabelEntry,
  type AddressLabelsSnapshot,
} from "@/lib/address-labels";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Accept two formats:
  // 1. Snapshot format: { exportedAt, chains: { chainId: { address: entry } } }
  // 2. Simple format:   { chainId, labels: { address: entry } }
  if (isSnapshot(body)) {
    try {
      await Promise.all(
        Object.entries(body.chains).map(([chainId, labels]) =>
          importLabels(Number(chainId), labels),
        ),
      );
      return NextResponse.json({ ok: true });
    } catch (err) {
      return serverError(err);
    }
  }

  const { chainId, labels } = body as Record<string, unknown>;
  if (
    typeof chainId !== "number" ||
    !Number.isInteger(chainId) ||
    chainId <= 0
  ) {
    return NextResponse.json({ error: "Invalid chainId" }, { status: 400 });
  }
  if (!isLabelsMap(labels)) {
    return NextResponse.json(
      { error: "labels must be an object mapping address → entry" },
      { status: 400 },
    );
  }

  try {
    await importLabels(chainId, labels);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return serverError(err);
  }
}

function isSnapshot(v: unknown): v is AddressLabelsSnapshot {
  return (
    typeof v === "object" &&
    v !== null &&
    "chains" in v &&
    typeof (v as AddressLabelsSnapshot).chains === "object"
  );
}

function isLabelsMap(v: unknown): v is Record<string, AddressLabelEntry> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function serverError(err: unknown): NextResponse {
  console.error("[address-labels/import]", err);
  const message = err instanceof Error ? err.message : "Internal server error";
  return NextResponse.json({ error: message }, { status: 500 });
}
