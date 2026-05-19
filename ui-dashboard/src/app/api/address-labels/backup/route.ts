import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { put } from "@vercel/blob";
import { getLabels, type AddressLabelsSnapshot } from "@/lib/address-labels";
import { getAllReports } from "@/lib/address-reports";
import { requireCronAuth } from "@/lib/cron-auth";

// Vercel cron jobs invoke with GET, not POST. Read-only handler taking no
// body — GET is the right verb.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const authBail = await requireCronAuth(req, "backup");
  if (authBail) return authBail;

  // withMonitor reports an in_progress check-in on entry and an ok/error
  // check-in on exit. Missed runs (vs. the declared schedule) fire a Sentry
  // alert. Schedule mirrors vercel.json crons entry.
  try {
    return await Sentry.withMonitor(
      "address-labels-backup",
      async () => {
        // Labels and forensic reports both live in the same Upstash instance
        // (separate hashes — `labels` and `reports`). Snapshot both into the
        // same daily JSON blob so a Redis flush restores both halves from one
        // file. Keeping them in one cron also avoids the risk of one half
        // restoring without the other.
        const [labels, reports] = await Promise.all([
          getLabels(),
          getAllReports(),
        ]);
        const now = new Date();
        const snapshot: AddressLabelsSnapshot = {
          exportedAt: now.toISOString(),
          addresses: labels,
          reports,
        };

        const date = now.toISOString().slice(0, 10);
        const filename = `address-labels-backup-${date}.json`;

        const blob = await put(filename, JSON.stringify(snapshot, null, 2), {
          access: "private",
          contentType: "application/json",
          addRandomSuffix: false,
        });

        return NextResponse.json({ ok: true, pathname: blob.pathname, date });
      },
      {
        // Cron schedule mirrors vercel.json — keep them in sync.
        schedule: { type: "crontab", value: "0 3 * * *" },
        checkinMargin: 5,
        maxRuntime: 10,
        timezone: "Etc/UTC",
      },
    );
  } catch (err) {
    Sentry.captureException(err, { tags: { route: "address-labels/backup" } });
    console.error("[backup]", err);
    return NextResponse.json({ error: "Backup failed" }, { status: 500 });
  }
}
