import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { put } from "@vercel/blob";
import { getAllLabels, type AddressLabelsSnapshot } from "@/lib/address-labels";
import { requireCronOrSession } from "@/lib/cron-auth";

// Vercel cron jobs invoke with GET, not POST. Read-only handler taking no
// body — GET is the right verb. (Cursor + Codex flagged this on PR #236.)
export async function GET(req: NextRequest): Promise<NextResponse> {
  const authBail = await requireCronOrSession(req, "backup");
  if (authBail) return authBail;

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
