#!/usr/bin/env node
import process from "node:process";

const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const missing = [
  ["UPSTASH_REDIS_REST_URL", redisUrl],
  ["UPSTASH_REDIS_REST_TOKEN", redisToken],
]
  .filter(([, value]) => !value)
  .map(([name]) => name);
if (missing.length > 0) {
  console.error(`Missing env: ${missing.join(", ")}`);
  process.exit(1);
}

async function upstash(path) {
  const res = await fetch(`${redisUrl}${path}`, {
    headers: { Authorization: `Bearer ${redisToken}` },
  });
  if (!res.ok)
    throw new Error(`Upstash ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

for (const hash of ["intel_entities", "intel_entity_cps", "intel_transfers"]) {
  console.log(`\n========== ${hash} ==========`);
  const { result: keys } = await upstash(`/hkeys/${hash}`);
  console.log(`Total: ${keys.length}`);
  for (const key of keys.slice(0, 2)) {
    const { result: value } = await upstash(
      `/hget/${hash}/${encodeURIComponent(key)}`,
    );
    console.log(`\n--- ${key} ---`);
    try {
      const parsed = JSON.parse(value);
      console.log(JSON.stringify(parsed, null, 2).slice(0, 3000));
    } catch {
      console.log(value?.slice(0, 1500));
    }
  }
}
// Also look for a transfers entry that's non-empty
console.log(`\n========== intel_transfers (non-empty samples) ==========`);
const { result: tk } = await upstash(`/hkeys/intel_transfers`);
let found = 0;
for (const key of tk) {
  const { result: value } = await upstash(
    `/hget/intel_transfers/${encodeURIComponent(key)}`,
  );
  try {
    const parsed = JSON.parse(value);
    if (
      parsed.transferCount > 0 ||
      (parsed.transfers && parsed.transfers.length > 0)
    ) {
      console.log(`\n--- ${key} (count=${parsed.transferCount}) ---`);
      console.log(JSON.stringify(parsed, null, 2).slice(0, 2500));
      found++;
      if (found >= 2) break;
    }
  } catch {}
}
if (!found) console.log("(no transfers found with content)");
