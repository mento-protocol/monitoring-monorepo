import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/auth";
import {
  importLabels,
  getLabels,
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

  // Accept three formats:
  // 1. Snapshot format:    { exportedAt, chains: { chainId: { address: entry } } }
  // 2. Simple format:      { chainId, labels: { address: entry } }
  // 3. Gnosis Safe format: [{ address, chainId, name }]
  if (isGnosisSafeFormat(body)) {
    const entries = body as Array<{
      address: string;
      chainId: string;
      name: string;
    }>;

    // Validate all entries upfront, then group by chainId.
    type ParsedEntry = { chainId: number; address: string; name: string };
    const parsed: ParsedEntry[] = [];
    for (const entry of entries) {
      // Strict decimal-only parse — reject "1e3", "0x1", and whitespace-padded
      // strings that Number() silently coerces to valid-looking chain IDs.
      // We intentionally do NOT trim: leading/trailing spaces are malformed input.
      if (!/^\d+$/.test(entry.chainId)) {
        return NextResponse.json(
          { error: `Invalid chainId: ${entry.chainId}` },
          { status: 400 },
        );
      }
      const chainId = parseInt(entry.chainId, 10);
      if (!Number.isInteger(chainId) || chainId <= 0) {
        return NextResponse.json(
          { error: `Invalid chainId: ${entry.chainId}` },
          { status: 400 },
        );
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(entry.address)) {
        return NextResponse.json(
          { error: `Invalid address: ${entry.address}` },
          { status: 400 },
        );
      }
      parsed.push({ chainId, address: entry.address, name: entry.name });
    }

    // Fetch existing labels for each distinct chainId so we can merge instead
    // of overwriting — preserves category, notes, isPublic from prior entries.
    const existingByChain = new Map<
      number,
      Record<string, AddressLabelEntry>
    >();
    const distinctChainIds = [...new Set(parsed.map((e) => e.chainId))];
    for (const chainId of distinctChainIds) {
      existingByChain.set(chainId, await getLabels(chainId));
    }

    const byChain = new Map<number, Record<string, AddressLabelEntry>>();
    for (const entry of parsed) {
      const { chainId, address, name } = entry;
      const existing = existingByChain.get(chainId) ?? {};
      const prev = existing[address.toLowerCase()];
      if (!byChain.has(chainId)) byChain.set(chainId, {});
      byChain.get(chainId)![address] = {
        // Preserve existing metadata; only overwrite label and timestamp.
        ...prev,
        label: name,
        updatedAt: new Date().toISOString(),
      };
    }

    try {
      for (const [chainId, labels] of byChain.entries()) {
        await importLabels(chainId, labels);
      }
      return NextResponse.json({ ok: true });
    } catch (err) {
      return serverError(err);
    }
  }

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

function isGnosisSafeFormat(
  v: unknown,
): v is Array<{ address: string; chainId: string; name: string }> {
  if (!Array.isArray(v)) return false;
  // An empty array is a valid (no-op) Gnosis Safe export — handle it as this
  // format so callers get 200 instead of a misleading "Invalid chainId" 400.
  if (v.length === 0) return true;
  return v.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).address === "string" &&
      typeof (entry as Record<string, unknown>).chainId === "string" &&
      typeof (entry as Record<string, unknown>).name === "string",
  );
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
