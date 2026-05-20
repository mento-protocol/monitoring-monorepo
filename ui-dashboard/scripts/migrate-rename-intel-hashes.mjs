#!/usr/bin/env node
/**
 * One-shot migration: rename the 5 Arkham Redis hash keys to their new intel_*
 * names using Upstash REST RENAME (atomic). Must run BEFORE deploying the
 * renamed dashboard code.
 *
 * Idempotent: skips any key that does not exist (already migrated or empty).
 *
 * Usage:
 *   UPSTASH_REDIS_REST_URL=<url> UPSTASH_REDIS_REST_TOKEN=<token> node scripts/migrate-rename-intel-hashes.mjs
 *
 * Or via the marathon runner:
 *   ./scripts/intel-marathon/run.sh migrate-rename
 */

const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!REST_URL || !REST_TOKEN) {
  console.error(
    "ERROR: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set",
  );
  process.exit(1);
}

const RENAMES = [
  ["arkham_deep", "intel_deep"],
  ["arkham_transfers", "intel_transfers"],
  ["arkham_wealth", "intel_wealth"],
  ["arkham_entities", "intel_entities"],
  ["arkham_entity_cps", "intel_entity_cps"],
];

async function upstash(command, ...args) {
  const url = `${REST_URL}/${[command, ...args].map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${REST_TOKEN}` },
  });
  const json = await res.json();
  if (json.error) throw new Error(`Upstash error: ${json.error}`);
  return json.result;
}

async function hlen(key) {
  return upstash("HLEN", key);
}

async function rename(src, dst) {
  return upstash("RENAME", src, dst);
}

async function exists(key) {
  return upstash("EXISTS", key);
}

async function main() {
  console.log("migrate-rename-intel-hashes: starting\n");

  for (const [src, dst] of RENAMES) {
    const srcExists = await exists(src);
    if (!srcExists) {
      console.log(`  skip ${src} → ${dst}  (key does not exist)`);
      continue;
    }
    const before = await hlen(src);
    await rename(src, dst);
    const after = await hlen(dst);
    console.log(
      `  renamed ${src} → ${dst}  (before=${before} fields, after=${after} fields)`,
    );
  }

  console.log("\nmigrate-rename-intel-hashes: done");
}

main().catch((err) => {
  console.error("migrate-rename-intel-hashes: FAILED", err);
  process.exit(1);
});
