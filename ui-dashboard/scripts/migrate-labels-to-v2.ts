/**
 * One-time migration script: labels v1 → v2
 *
 * Reads all `labels:*` Redis hashes and transforms each entry:
 *   - `label` → `name`
 *   - `category` → first element of `tags[]` (if present)
 *   - Drops `category` field
 *   - Adds `tags: []` default
 *
 * IMPORTANT: Deploy the backward-compat read path (upgradeEntry) BEFORE
 * running this script. That way, partial migration failures are safe —
 * un-migrated entries are auto-upgraded on read.
 *
 * Usage:
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... npx tsx scripts/migrate-labels-to-v2.ts [--dry-run]
 */

import { Redis } from "@upstash/redis";

const DRY_RUN = process.argv.includes("--dry-run");

interface V1Entry {
  label: string;
  category?: string;
  notes?: string;
  isPublic?: boolean;
  updatedAt: string;
}

interface V2Entry {
  name: string;
  tags: string[];
  notes?: string;
  isPublic?: boolean;
  updatedAt: string;
}

function isV1Entry(entry: Record<string, unknown>): boolean {
  return typeof entry.label === "string" && !("name" in entry);
}

function migrateEntry(entry: V1Entry): V2Entry {
  const tags: string[] = [];
  if (entry.category && entry.category.trim()) {
    tags.push(entry.category.trim());
  }
  return {
    name: entry.label,
    tags,
    ...(entry.notes !== undefined ? { notes: entry.notes } : {}),
    ...(entry.isPublic !== undefined ? { isPublic: entry.isPublic } : {}),
    updatedAt: entry.updatedAt,
  };
}

async function main() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.error(
      "Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN env vars.",
    );
    process.exit(1);
  }

  const redis = new Redis({ url, token });

  if (DRY_RUN) {
    console.log("=== DRY RUN — no writes will be performed ===\n");
  }

  // Discover all labels:* keys via SCAN
  const allKeys: string[] = [];
  let cursor = 0;
  do {
    const [nextCursor, batch] = await redis.scan(cursor, {
      match: "labels:*",
      count: 100,
    });
    cursor = Number(nextCursor);
    allKeys.push(...batch);
  } while (cursor !== 0);

  console.log(`Found ${allKeys.length} label key(s): ${allKeys.join(", ")}\n`);

  let totalMigrated = 0;
  let totalSkipped = 0;

  for (const key of allKeys) {
    const raw =
      await redis.hgetall<Record<string, Record<string, unknown>>>(key);
    if (!raw) {
      console.log(`  ${key}: empty, skipping`);
      continue;
    }

    const toWrite: Record<string, V2Entry> = {};
    let migrated = 0;
    let skipped = 0;

    for (const [address, entry] of Object.entries(raw)) {
      if (isV1Entry(entry as Record<string, unknown>)) {
        toWrite[address] = migrateEntry(entry as unknown as V1Entry);
        migrated++;
      } else {
        skipped++;
      }
    }

    console.log(`  ${key}: ${migrated} to migrate, ${skipped} already v2`);

    if (migrated > 0 && !DRY_RUN) {
      await redis.hset(key, toWrite);
      console.log(`    ✓ wrote ${migrated} entries`);
    }

    totalMigrated += migrated;
    totalSkipped += skipped;
  }

  console.log(
    `\nDone. Migrated: ${totalMigrated}, Already v2: ${totalSkipped}${DRY_RUN ? " (dry run)" : ""}`,
  );
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
