#!/usr/bin/env node
// Measure serialized byte size of each Arkham hash to size backup cron.
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const HASHES = [
  "labels",
  "reports",
  "intel_deep",
  "intel_transfers",
  "intel_wealth",
  "intel_entities",
  "intel_entity_cps",
];

for (const hash of HASHES) {
  const all = await redis.hgetall(hash);
  const size = JSON.stringify(all ?? {}).length;
  const entries = Object.keys(all ?? {}).length;
  console.log(
    `${hash.padEnd(22)} entries=${String(entries).padStart(5)} bytes=${size.toLocaleString().padStart(12)} (${(size / 1024 / 1024).toFixed(2)} MB)`,
  );
}
