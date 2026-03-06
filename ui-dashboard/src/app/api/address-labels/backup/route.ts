import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import {
  getAllChainLabels,
  type AddressLabelsSnapshot,
} from "@/lib/address-labels";

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Vercel Cron authenticates requests with the CRON_SECRET env var.
  // In production, reject unauthenticated calls to this endpoint.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const chains = await getAllChainLabels();
    const totalLabels = Object.values(chains).reduce(
      (sum, entries) => sum + Object.keys(entries).length,
      0,
    );

    const snapshot: AddressLabelsSnapshot = {
      exportedAt: new Date().toISOString(),
      chains,
    };

    const date = new Date().toISOString().slice(0, 10);
    const filename = `address-labels-backup-${date}.json`;

    await put(filename, JSON.stringify(snapshot, null, 2), {
      access: "public",
      contentType: "application/json",
      // Overwrite any existing backup for the same date
      addRandomSuffix: false,
    });

    return NextResponse.json({ ok: true, totalLabels, filename });
  } catch (err) {
    console.error("[address-labels/backup]", err);
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
