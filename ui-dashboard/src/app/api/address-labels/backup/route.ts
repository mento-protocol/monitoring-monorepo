import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/auth";
import {
  getAllChainLabels,
  getRedis,
  type AddressLabelsSnapshot,
} from "@/lib/address-labels";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  const isDev = process.env.NODE_ENV === "development";

  if (!isDev) {
    if (!cronSecret) {
      console.error(
        "[backup] CRON_SECRET is not set. Refusing backup request.",
      );
      return NextResponse.json(
        { error: "Server misconfiguration: CRON_SECRET required" },
        { status: 500 },
      );
    }

    const authHeader = req.headers.get("authorization");
    const isCronAuth = authHeader === `Bearer ${cronSecret}`;

    if (!isCronAuth) {
      const session = await getAuthSession();
      if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }
  }

  try {
    const chains = await getAllChainLabels();
    const snapshot: AddressLabelsSnapshot = {
      exportedAt: new Date().toISOString(),
      chains,
    };

    const redis = getRedis();
    const randomSuffix = crypto.randomUUID().slice(0, 8);
    const date = new Date().toISOString().slice(0, 10);
    const backupKey = `address-labels:backup:${date}:${randomSuffix}`;

    await redis.set(backupKey, JSON.stringify(snapshot), {
      ex: 30 * 24 * 60 * 60, // 30-day TTL
    });

    console.log(`[backup] Stored backup at Redis key: ${backupKey}`);
    return NextResponse.json({ ok: true, key: backupKey, date });
  } catch (err) {
    console.error("[backup]", err);
    const message = err instanceof Error ? err.message : "Backup failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
