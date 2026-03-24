import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/auth";
import {
  importLabels,
  type AddressLabelEntry,
  type AddressLabelsSnapshot,
} from "@/lib/address-labels";

export async function POST(req: NextRequest): Promise<NextResponse> {
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

  // Accept two formats:
  // 1. Snapshot format: { exportedAt, chains: { chainId: { address: entry } } }
  // 2. Simple format:   { chainId, labels: { address: entry } }
  if (isSnapshot(body)) {
    const chainEntries = Object.entries(body.chains);

    // Validate all chains upfront before writing anything
    for (const [key, labels] of chainEntries) {
      const n = Number(key);
      if (!Number.isInteger(n) || n <= 0) {
        return NextResponse.json(
          { error: `Invalid chainId key: ${key}` },
          { status: 400 },
        );
      }
      if (!isLabelsMap(labels)) {
        return NextResponse.json(
          { error: `Invalid labels map for chainId ${key}` },
          { status: 400 },
        );
      }
    }

    try {
      for (const [chainId, labels] of chainEntries) {
        await importLabels(Number(chainId), labels);
      }
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
  if (typeof v !== "object" || v === null || !("chains" in v)) return false;
  const { chains } = v as AddressLabelsSnapshot;
  return (
    typeof chains === "object" && chains !== null && !Array.isArray(chains)
  );
}

function isLabelsMap(v: unknown): v is Record<string, AddressLabelEntry> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as AddressLabelEntry).label === "string",
  );
}

function serverError(err: unknown): NextResponse {
  console.error("[address-labels/import]", err);
  const message = err instanceof Error ? err.message : "Internal server error";
  return NextResponse.json({ error: message }, { status: 500 });
}
