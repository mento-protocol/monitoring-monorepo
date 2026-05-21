#!/usr/bin/env node
// Dump one sample record from each Arkham Upstash hash, so subagents
// can write components against accurate shapes.
import process from "node:process";

const required = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing env: ${missing.join(", ")}`);
  process.exit(1);
}
const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

async function upstash(path) {
  const res = await fetch(`${redisUrl}${path}`, {
    headers: { Authorization: `Bearer ${redisToken}` },
  });
  if (!res.ok)
    throw new Error(`Upstash ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

const HASHES = [
  "intel_deep",
  "intel_transfers",
  "intel_wealth",
  "intel_entities",
  "intel_entity_cps",
];

for (const hash of HASHES) {
  console.log(`\n========== ${hash} ==========`);
  const { result: keys } = await upstash(`/hkeys/${hash}`);
  console.log(`Total entries: ${keys.length}`);
  if (keys.length === 0) continue;
  const sample = keys[0];
  const { result: value } = await upstash(
    `/hget/${hash}/${encodeURIComponent(sample)}`,
  );
  console.log(`Sample key: ${sample}`);
  try {
    const parsed = JSON.parse(value);
    console.log(JSON.stringify(parsed, null, 2).slice(0, 8000));
  } catch {
    console.log(value?.slice(0, 2000));
  }
}
