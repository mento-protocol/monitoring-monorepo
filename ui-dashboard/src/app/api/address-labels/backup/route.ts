import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { put } from "@vercel/blob";
import { getLabels } from "@/lib/address-labels";
import { getAllReports } from "@/lib/address-reports";
import { getAllIntelDeep } from "@/lib/intel-deep";
import { getAllIntelTransfers } from "@/lib/intel-transfers";
import { getAllIntelWealth } from "@/lib/intel-wealth";
import { getAllIntelEntities } from "@/lib/intel-entities";
import { getAllIntelEntityCps } from "@/lib/intel-entity-cps";
import { requireCronAuth } from "@/lib/cron-auth";
import { MAX_RESTORE_BLOB_BYTES } from "@/app/api/address-labels/restore/route";
import { findUnchunkableField } from "@/lib/redis-hash";
import {
  type BackupManifestV2,
  BACKUP_MANIFEST_VERSION,
  HASH_BLOB_NAMES,
  manifestPathname,
  type SnapshotHashName,
  hashBlobPathname,
} from "@/lib/address-labels/backup-format";

// 5min serverless-function budget covers the steady-state cron: 7 parallel
// HGETALLs + 8 parallel blob uploads (one per hash + manifest). Per-hash
// blob splits keep any single upload under ~10 MB, so the bound is mostly
// HGETALL latency on the largest hash (intel_deep).
export const maxDuration = 300;
export const BACKUP_MONITOR_MAX_RUNTIME_MINUTES = Math.ceil(maxDuration / 60);

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
        // Read all 7 hashes from Upstash in parallel. labels + reports lead
        // (the load-bearing pair restored before intel data); intel hashes
        // follow in any order — they don't have cross-hash invariants.
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
        const date = now.toISOString().slice(0, 10);
        const exportedAtISO = now.toISOString();

        // v2 per-hash blob splits: each hash gets its own blob under the
        // day's prefix, plus a manifest blob that lists them. Keeps every
        // single blob under ~10 MB (largest is intel_deep at ~7 MB) so the
        // 32 MB restore-side blob cap stops biting. Restore reads the
        // manifest first, then fetches the referenced hash blobs in parallel.
        //
        // Hash blobs use `addRandomSuffix: true` so each run writes unique
        // pathnames — a retry after a partial upload failure cannot overwrite
        // the prior run's blobs and produce a torn snapshot mid-`Promise.all`.
        // The manifest stays at a deterministic per-day path so restore has
        // a single known entry point; it points at the actual pathnames each
        // `put()` returned. Old per-run hash blobs that aren't referenced by
        // the latest manifest become orphans — collectable by a cleanup job
        // later (cheap relative to the safety win).
        const hashRecords: Record<SnapshotHashName, Record<string, unknown>> = {
          labels,
          reports,
          intelDeep,
          intelTransfers,
          intelWealth,
          intelEntities,
          intelEntityCps,
        };

        // Upload each hash blob in parallel. We can't include the upload
        // results in the manifest until they resolve, so this is a two-phase
        // dispatch: hash blobs first (parallel), then the manifest (writes
        // the resolved pathnames + sizes).
        const hashUploads = await Promise.all(
          HASH_BLOB_NAMES.map(async (name) => {
            const pathnamePrefix = hashBlobPathname(date, name);
            const serialized = JSON.stringify(hashRecords[name], null, 2);
            const sizeBytes = Buffer.byteLength(serialized, "utf8");
            const result = await put(pathnamePrefix, serialized, {
              access: "private",
              contentType: "application/json",
              // Unique pathname per run; manifest references result.pathname.
              addRandomSuffix: true,
              // Fail fast if the Blob API hangs — otherwise a single stuck
              // upload would block the whole cron until the 5min maxDuration
              // budget elapses.
              abortSignal: AbortSignal.timeout(30_000),
            });
            return { name, pathname: result.pathname, sizeBytes };
          }),
        );

        flagRestoreBreakingSnapshot(hashUploads, hashRecords);

        const manifest: BackupManifestV2 = {
          version: BACKUP_MANIFEST_VERSION,
          exportedAt: exportedAtISO,
          hashes: hashUploads,
        };

        const manifestBlobPath = manifestPathname(date);
        await put(manifestBlobPath, JSON.stringify(manifest, null, 2), {
          access: "private",
          contentType: "application/json",
          addRandomSuffix: false,
          // Same rationale as the hash-blob put above — retries must
          // overwrite the prior manifest at this pathname.
          allowOverwrite: true,
          abortSignal: AbortSignal.timeout(30_000),
        });

        return NextResponse.json({
          ok: true,
          pathname: manifestBlobPath,
          date,
          hashes: hashUploads.map((h) => ({
            name: h.name,
            sizeBytes: h.sizeBytes,
          })),
        });
      },
      {
        // Cron schedule mirrors vercel.json — keep them in sync.
        schedule: { type: "crontab", value: "0 3 * * *" },
        checkinMargin: 5,
        // Match the function's 5min execution cap. A longer monitor window
        // hides hung runs after Vercel has already terminated the handler.
        maxRuntime: BACKUP_MONITOR_MAX_RUNTIME_MINUTES,
        timezone: "Etc/UTC",
      },
    );
  } catch (err) {
    Sentry.captureException(err, { tags: { route: "address-labels/backup" } });
    console.error("[backup]", err);
    return NextResponse.json({ error: "Backup failed" }, { status: 500 });
  }
}

/**
 * Backup-time preflight: two distinct restore-failure modes to flag.
 *
 * 1. Per-blob oversize: the restore route refuses any single blob
 *    > MAX_RESTORE_BLOB_BYTES (16 MB), so a hash that grows past that
 *    cap makes every restore from this snapshot 413.
 * 2. Per-field unsplittable: even a sub-16MB blob can deterministically
 *    fail restore if any single field/value pair exceeds the chunked-
 *    HSET budget — restore's chunkedHashWrite throws before any write.
 *
 * Backup still succeeds in either case (the raw blob is salvageable
 * manually), but a Sentry warning surfaces the impending DR break before
 * someone tries to restore.
 */
function flagRestoreBreakingSnapshot(
  hashUploads: Array<{
    name: SnapshotHashName;
    pathname: string;
    sizeBytes: number;
  }>,
  hashRecords: Record<SnapshotHashName, Record<string, unknown>>,
): void {
  for (const upload of hashUploads) {
    if (upload.sizeBytes > MAX_RESTORE_BLOB_BYTES) {
      Sentry.captureMessage(
        `[backup] hash blob ${upload.name} ${upload.sizeBytes} bytes exceeds restore cap ${MAX_RESTORE_BLOB_BYTES} — disaster-recovery restore would reject this snapshot`,
        {
          level: "warning",
          tags: { route: "address-labels/backup", hash: upload.name },
        },
      );
    }
    // Build the wire-format fields the same way restore will: every value
    // JSON-encoded once for HSET. Approximates the per-field check
    // chunkedHashWrite uses; off by a few bytes from per-hash key naming
    // but the headroom in MAX_REDIS_HASH_REPLACE_BYTES absorbs that.
    const wireFields: Record<string, string> = {};
    for (const [field, value] of Object.entries(hashRecords[upload.name])) {
      wireFields[field.toLowerCase()] = JSON.stringify(value);
    }
    const unsplittable = findUnchunkableField(upload.name, wireFields);
    if (unsplittable) {
      Sentry.captureMessage(
        `[backup] hash ${upload.name} has unsplittable field ${unsplittable.field} (${unsplittable.bytes} bytes > chunked-HSET cap) — disaster-recovery restore would fail on this hash`,
        {
          level: "warning",
          tags: {
            route: "address-labels/backup",
            hash: upload.name,
            field: unsplittable.field,
          },
        },
      );
    }
  }
}
