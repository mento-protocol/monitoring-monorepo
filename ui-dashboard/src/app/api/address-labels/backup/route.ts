import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { put } from "@vercel/blob";
import { getAuthSession } from "@/auth";
import { getAllLabels, type AddressLabelsSnapshot } from "@/lib/address-labels";

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

  // withMonitor reports an in_progress check-in on entry and an ok/error
  // check-in on exit. Missed runs (vs. the declared schedule) fire a Sentry
  // alert. Schedule mirrors vercel.json crons entry.
  try {
    return await Sentry.withMonitor(
      "address-labels-backup",
      async () => {
        const { global, chains } = await getAllLabels();
        const snapshot: AddressLabelsSnapshot = {
          exportedAt: new Date().toISOString(),
          global,
          chains,
        };

        const date = new Date().toISOString().slice(0, 10);
        const filename = `address-labels-backup-${date}.json`;

        const blob = await put(filename, JSON.stringify(snapshot, null, 2), {
          access: "private",
          contentType: "application/json",
          addRandomSuffix: false,
        });

        return NextResponse.json({ ok: true, pathname: blob.pathname, date });
      },
      {
        schedule: { type: "crontab", value: "0 3 * * *" },
        checkinMargin: 5,
        maxRuntime: 10,
        timezone: "Etc/UTC",
      },
    );
  } catch (err) {
    // Full error is in Sentry; return a generic string to the client.
    Sentry.captureException(err, { tags: { route: "address-labels/backup" } });
    console.error("[backup]", err);
    return NextResponse.json({ error: "Backup failed" }, { status: 500 });
  }
}
