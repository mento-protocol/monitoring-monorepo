#!/usr/bin/env node
/**
 * Verification — prints marathon coverage metrics.
 *
 * Usage:
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... \
 *   node ui-dashboard/scripts/intel-marathon/verify.mjs
 */

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

async function pipeline(commands) {
  const res = await fetch(`${redisUrl}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${redisToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok)
    throw new Error(`Upstash pipeline → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const startedAt = Date.now();

  console.log("=== Arkham Marathon — Verification ===\n");

  const [labelsLen, deepLen, reportsLen] = await pipeline([
    ["HLEN", "labels"],
    ["HLEN", "intel_deep"],
    ["HLEN", "reports"],
  ]);

  console.log(`Hash sizes:`);
  console.log(`  labels:      ${labelsLen.result}`);
  console.log(`  intel_deep: ${deepLen.result}`);
  console.log(`  reports:     ${reportsLen.result}`);
  console.log("");

  // Sample 10 random intel_deep rows.
  const { result: keys } = await upstash(`/hkeys/intel_deep`);
  if (keys.length > 0) {
    console.log("Random intel_deep samples:");
    const sample = [];
    const seen = new Set();
    while (sample.length < Math.min(10, keys.length)) {
      const i = Math.floor(Math.random() * keys.length);
      if (seen.has(i)) continue;
      seen.add(i);
      sample.push(keys[i]);
    }
    for (const addr of sample) {
      const { result } = await upstash(`/hget/intel_deep/${addr}`);
      try {
        const rec = JSON.parse(result);
        // counterparties is keyed by chain (e.g. {ethereum: [...], polygon: [...]})
        // not by in/out — sum across all chain arrays.
        const cpCount = Object.values(rec.counterparties ?? {})
          .filter(Array.isArray)
          .reduce((acc, arr) => acc + arr.length, 0);
        // Prefer the top-level entity.name; fall back to the first enriched
        // chain entry that has an arkhamEntity attached. Old code routed
        // through `rec.enriched` even when `rec.entity.name` was set, ignoring
        // the more specific top-level name.
        const entityName =
          rec.entity?.name ??
          Object.values(rec.enriched ?? {}).find((c) => c.arkhamEntity?.name)
            ?.arkhamEntity?.name ??
          null;
        console.log(
          `  ${addr}  cps=${cpCount}  entity=${entityName ?? "(none)"}`,
        );
      } catch {
        console.log(`  ${addr}  (parse error)`);
      }
    }
    console.log("");
  }

  // Tag distribution in labels.
  const { result: rawLabels } = await upstash(`/hgetall/labels`);
  const tagCounts = new Map();
  let arkhamSourced = 0;
  for (let i = 0; i < rawLabels.length; i += 2) {
    try {
      const entry = JSON.parse(rawLabels[i + 1]);
      if (entry.source === "arkham") arkhamSourced++;
      for (const tag of entry.tags ?? []) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    } catch {
      /* skip */
    }
  }
  console.log(`labels with source=arkham: ${arkhamSourced}`);
  console.log("");
  console.log("Top 20 tags:");
  const ranked = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
  for (const [tag, count] of ranked) {
    console.log(`  ${count.toString().padStart(5)} ${tag}`);
  }
  console.log("");

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`✓ Verification complete (${elapsed}s)`);
}

main().catch((err) => {
  console.error("✗ FAILED:", err.message);
  process.exit(1);
});
