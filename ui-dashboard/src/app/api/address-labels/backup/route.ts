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
        // Pathnames are deterministic per-day (`addRandomSuffix: false`) so
        // the manifest path is predictable and a re-run overwrites the same
        // blobs cleanly. Two backup runs colliding on the same day could in
        // principle interleave per-hash writes before the manifest lands and
        // produce a torn snapshot (codex P2 #6, deferred): Vercel cron only
        // fires once per `0 3 * * *` slot so the daily path is not at risk;
        // an operator manually curling /backup during the scheduled run is
        // the only way to trigger it, and that's a known operator hazard.
        // If we ever want true atomicity, the fix is `addRandomSuffix: true`
        // on the hash blobs (manifest still deterministic, points at the
        // random pathnames) — left out here to avoid blob-storage churn.
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
            const pathname = hashBlobPathname(date, name);
            const serialized = JSON.stringify(hashRecords[name], null, 2);
            const sizeBytes = Buffer.byteLength(serialized, "utf8");
            await put(pathname, serialized, {
              access: "private",
              contentType: "application/json",
              addRandomSuffix: false,
              // Fail fast if the Blob API hangs — otherwise a single stuck
              // upload would block the whole cron until the 5min maxDuration
              // budget elapses (cursor Low).
              abortSignal: AbortSignal.timeout(30_000),
            });
            return { name, pathname, sizeBytes };
          }),
        );

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
        // 60min Sentry budget reflects the realistic upper bound for a
        // 7-hash HGETALL fan-out + 8 parallel Blob uploads (one per hash +
        // manifest). With per-hash blob splits no single upload is large,
        // but Upstash HGETALL latency dominates for intel_deep.
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
