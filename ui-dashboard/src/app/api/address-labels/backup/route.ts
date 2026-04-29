import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { put } from "@vercel/blob";
import { getAllLabels, type AddressLabelsSnapshot } from "@/lib/address-labels";
import { requireCronAuth } from "@/lib/cron-auth";

// Vercel cron jobs invoke with GET, not POST. Read-only handler taking no
// body — GET is the right verb. (Cursor + Codex flagged this on PR #236.)
export async function GET(req: NextRequest): Promise<NextResponse> {
  const authBail = await requireCronAuth(req, "backup");
  if (authBail) return authBail;

  // No Sentry cron monitor here: the team plan covers one cron slot, which
  // goes to arkham-enrich (the more time-sensitive job). In-body failures
  // still hit Sentry via captureException. Missed runs are NOT actively
  // monitored — recovery is by spot-checking the Blob store for a missing
  // date file.
  try {
    const { global, chains } = await getAllLabels();
    const now = new Date();
    const snapshot: AddressLabelsSnapshot = {
      exportedAt: now.toISOString(),
      global,
      chains,
    };

    const date = now.toISOString().slice(0, 10);
    const filename = `address-labels-backup-${date}.json`;

    const blob = await put(filename, JSON.stringify(snapshot, null, 2), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    return NextResponse.json({ ok: true, pathname: blob.pathname, date });
  } catch (err) {
    Sentry.captureException(err, { tags: { route: "address-labels/backup" } });
    console.error("[backup]", err);
    return NextResponse.json({ error: "Backup failed" }, { status: 500 });
  }
}
