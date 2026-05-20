import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { put } from "@vercel/blob";
import { getLabels, type AddressLabelsSnapshot } from "@/lib/address-labels";
import { getAllReports } from "@/lib/address-reports";
import { getAllIntelDeep } from "@/lib/intel-deep";
import { getAllIntelTransfers } from "@/lib/intel-transfers";
import { getAllIntelWealth } from "@/lib/intel-wealth";
import { getAllIntelEntities } from "@/lib/intel-entities";
import { getAllIntelEntityCps } from "@/lib/intel-entity-cps";
import { requireCronAuth } from "@/lib/cron-auth";
import { MAX_RESTORE_BLOB_BYTES } from "@/app/api/address-labels/restore/route";
import {
  MAX_REDIS_HASH_REPLACE_BYTES,
  restoreReplacePayloadBytes,
} from "@/lib/redis-hash";

// Bumped from the platform default (60s on Pro) to cover the ~19MB combined
// snapshot — 7 parallel HGETALLs + a single Blob upload. Largest single hash
// is intel_deep at ~7.3MB; if it ever crosses ~10MB the cron should switch
// to per-hash blob splits (or HSCAN paging) — track the size via measure-hash-bytes.
export const maxDuration = 300;

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
        const [
          labels,
          reports,
          intelDeep,
          intelTransfers,
          intelWealth,
          intelEntities,
          intelEntityCps,
        ] = await Promise.all([
          getLabels(),
          getAllReports(),
          getAllIntelDeep(),
          getAllIntelTransfers(),
          getAllIntelWealth(),
          getAllIntelEntities(),
          getAllIntelEntityCps(),
        ]);
        const now = new Date();
        const snapshot: AddressLabelsSnapshot = {
          exportedAt: now.toISOString(),
          addresses: labels,
          reports,
          intelDeep,
          intelTransfers,
          intelWealth,
          intelEntities,
          intelEntityCps,
        };

        const date = now.toISOString().slice(0, 10);
        const filename = `address-labels-backup-${date}.json`;

        // Preflight against the restore route's invariants (blob 32 MB cap,
        // per-hash 8 MB cap). Backups still proceed when over budget — the
        // raw blob is salvageable manually — but a Sentry warning fires so
        // we notice before the daily disaster-recovery path quietly breaks.
        const serialized = JSON.stringify(snapshot, null, 2);
        flagOversizeBackup(serialized, {
          labels,
          reports,
          intelDeep,
          intelTransfers,
          intelWealth,
          intelEntities,
          intelEntityCps,
        });

        const blob = await put(filename, serialized, {
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
        // 60min Sentry budget reflects the realistic upper bound for a
        // ~19MB combined HGETALL + Blob upload; the prior 10min budget was
        // unachievable once the 5 Arkham hashes joined the snapshot.
        maxRuntime: 60,
        timezone: "Etc/UTC",
      },
    );
  } catch (err) {
    Sentry.captureException(err, { tags: { route: "address-labels/backup" } });
    console.error("[backup]", err);
    return NextResponse.json({ error: "Backup failed" }, { status: 500 });
  }
}

function flagOversizeBackup(
  serialized: string,
  hashes: Record<string, Record<string, unknown>>,
): void {
  const blobBytes = Buffer.byteLength(serialized, "utf8");
  if (blobBytes > MAX_RESTORE_BLOB_BYTES) {
    Sentry.captureMessage(
      `[backup] blob ${blobBytes} bytes exceeds restore cap ${MAX_RESTORE_BLOB_BYTES} — disaster-recovery restore will reject this snapshot`,
      { level: "warning", tags: { route: "address-labels/backup" } },
    );
  }
  for (const [name, hash] of Object.entries(hashes)) {
    // Use the true EVAL payload size — what the restore would actually send
    // to Upstash — rather than the raw JSON.stringify(records) size. The wire
    // payload is meaningfully larger because each record gets a second JSON
    // encode inside the HSET argv, plus the Lua script + key array. Without
    // this, a near-cap hash can silently slip past preflight and only fail at
    // restore time.
    const replacementFields: Record<string, string> = {};
    for (const [field, value] of Object.entries(hash)) {
      replacementFields[field.toLowerCase()] = JSON.stringify(value);
    }
    const hashBytes = restoreReplacePayloadBytes({
      key: name,
      fields: replacementFields,
    });
    if (hashBytes > MAX_REDIS_HASH_REPLACE_BYTES) {
      Sentry.captureMessage(
        `[backup] hash ${name} EVAL payload ${hashBytes} bytes exceeds per-script cap ${MAX_REDIS_HASH_REPLACE_BYTES} — restore will fail on this hash`,
        {
          level: "warning",
          tags: { route: "address-labels/backup", hash: name },
        },
      );
    }
  }
}
