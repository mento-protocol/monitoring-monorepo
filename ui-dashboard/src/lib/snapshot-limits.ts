/**
 * Shared upper bound for one Redis hash snapshot. Backup and restore use
 * 16 MiB as the per-hash operational envelope; consumers that read a whole
 * hash must accept the same valid dataset range.
 */
export const MAX_SNAPSHOT_HASH_BYTES = 16 * 1024 * 1024;
