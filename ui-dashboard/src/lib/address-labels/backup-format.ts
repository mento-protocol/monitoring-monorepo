/**
 * Backup snapshot blob format — shared between
 * `/api/address-labels/backup` (writer) and `/api/address-labels/restore`
 * (reader).
 *
 * v2 format (current): per-hash blob splits + manifest
 * ─────────────────────────────────────────────────────
 * Background: a single monolithic snapshot blob crossed both restore-path
 * caps on 2026-05-21 — total > 32 MB blob cap and `intel_deep` > 8 MB
 * Upstash EVAL cap. v2 writes one blob per hash plus a manifest that lists
 * them; restore fetches the manifest first, then the referenced hash blobs
 * in parallel, then dispatches each replacement separately. No single blob
 * crosses ~10 MB, and per-hash chunked HSET dispatch in `redis-hash.ts`
 * handles any hash size at restore time.
 *
 * v1 format (legacy, restore-only): single monolithic blob at
 * `address-labels-backup-YYYY-MM-DD.json` containing the full
 * `AddressLabelsSnapshot`. Backup no longer writes v1; restore still
 * accepts it so historical blobs are recoverable.
 */

export const BACKUP_MANIFEST_VERSION = "v2-per-hash" as const;

/**
 * The 7 snapshot hash names. Ordered so labels + reports lead — they form
 * the load-bearing "core" pair and must stay listed first for any restore
 * code that wants to apply them before the larger intel hashes.
 */
export const HASH_BLOB_NAMES = [
  "labels",
  "reports",
  "intelDeep",
  "intelTransfers",
  "intelWealth",
  "intelEntities",
  "intelEntityCps",
] as const;

export type SnapshotHashName = (typeof HASH_BLOB_NAMES)[number];

/** v2 manifest blob shape. */
export type BackupManifestV2 = {
  version: typeof BACKUP_MANIFEST_VERSION;
  exportedAt: string;
  hashes: Array<{
    name: SnapshotHashName;
    pathname: string;
    sizeBytes: number;
  }>;
};

/**
 * Pathname conventions. All v2 blobs live under a per-day prefix so listing
 * by prefix groups a day's snapshot, and the manifest pathname is a
 * deterministic single entry point.
 */
export function manifestPathname(dateISO: string): string {
  return `address-labels-backup-${dateISO}/manifest.json`;
}

export function hashBlobPathname(
  dateISO: string,
  hash: SnapshotHashName,
): string {
  return `address-labels-backup-${dateISO}/${hash}.json`;
}

/**
 * Type guard for the v2 manifest shape (used by restore). Enforces that the
 * manifest lists EXACTLY the expected 7 hash names, each appearing once.
 * A manifest that's missing a hash or has duplicates would assemble into
 * a partial snapshot — and in replace mode `handleSnapshot` only writes
 * fields present in the snapshot, so an omitted hash leaves Redis with the
 * pre-restore state for that hash. That silently defeats the route's
 * "restore is all-or-nothing per hash" invariant (codex P2).
 */
export function isBackupManifestV2(value: unknown): value is BackupManifestV2 {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.version !== BACKUP_MANIFEST_VERSION) return false;
  if (typeof obj.exportedAt !== "string") return false;
  if (!Array.isArray(obj.hashes)) return false;
  const everyEntryWellShaped = obj.hashes.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    return (
      typeof e.name === "string" &&
      HASH_BLOB_NAMES.includes(e.name as SnapshotHashName) &&
      typeof e.pathname === "string" &&
      typeof e.sizeBytes === "number" &&
      Number.isFinite(e.sizeBytes)
    );
  });
  if (!everyEntryWellShaped) return false;
  // Exactly one entry per expected name. Cardinality check first (must equal
  // the expected count); uniqueness follows from cardinality + name coverage.
  if (obj.hashes.length !== HASH_BLOB_NAMES.length) return false;
  const seenNames = new Set(
    obj.hashes.map((e) => (e as { name: string }).name),
  );
  if (seenNames.size !== HASH_BLOB_NAMES.length) return false;
  for (const expected of HASH_BLOB_NAMES) {
    if (!seenNames.has(expected)) return false;
  }
  return true;
}
