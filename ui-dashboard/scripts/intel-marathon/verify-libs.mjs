#!/usr/bin/env node
/**
 * Smoke-test the new arkham lib functions by reading sample records.
 * Confirms the API route → lib → Upstash data path works end-to-end.
 *
 * Run via: bash ui-dashboard/scripts/intel-marathon/run.sh verify-libs
 */
import { Redis } from "@upstash/redis";

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) {
  console.error(
    "Missing Upstash env. Run via run.sh which bootstraps from tfvars.",
  );
  process.exit(1);
}
const redis = new Redis({ url, token });

const samples = [
  { hash: "arkham_deep", key: "0x747ff380cd43248824ec4d16510142e63b6e3b7e" },
  {
    hash: "arkham_transfers",
    key: "0xb28837949e7a3f1ac862036e8a0ae392c9ff9bb4",
  },
  { hash: "arkham_wealth", key: "0x747ff380cd43248824ec4d16510142e63b6e3b7e" },
  { hash: "arkham_entities", key: "openocean" },
  { hash: "arkham_entity_cps", key: "sharofbek84" },
];

for (const { hash, key } of samples) {
  const value = await redis.hget(hash, key);
  if (!value) {
    console.log(`✗ ${hash} / ${key}: not found`);
    continue;
  }
  const summary =
    typeof value === "string"
      ? `${value.length} chars`
      : `parsed obj keys: ${Object.keys(value).slice(0, 5).join(", ")}…`;
  console.log(`✓ ${hash} / ${key}: ${summary}`);
}

const counts = {};
for (const hash of [
  "arkham_deep",
  "arkham_transfers",
  "arkham_wealth",
  "arkham_entities",
  "arkham_entity_cps",
]) {
  const keys = await redis.hkeys(hash);
  counts[hash] = keys?.length ?? 0;
}
console.log("\nHash counts:", counts);
