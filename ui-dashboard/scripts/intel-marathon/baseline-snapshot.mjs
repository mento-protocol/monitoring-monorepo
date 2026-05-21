#!/usr/bin/env node
/**
 * Hour-0 baseline: snapshot existing `labels` + `reports` Upstash hashes to
 * disk + Vercel Blob, then health-check the Arkham API key. Run this FIRST
 * — every later tier writes to those hashes, and without a baseline a botched
 * script can't be rolled back.
 *
 * Usage:
 *   UPSTASH_REDIS_REST_URL=... \
 *   UPSTASH_REDIS_REST_TOKEN=... \
 *   ARKHAM_API_KEY=... \
 *   BLOB_READ_WRITE_TOKEN=... \
 *   node ui-dashboard/scripts/intel-marathon/baseline-snapshot.mjs
 */

import process from "node:process";
import { writeFileSync, mkdirSync } from "node:fs";
import { put } from "@vercel/blob";

const ARKHAM_BASE = "https://api.arkm.com";
const OUT_DIR = ".intel-marathon";

const required = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "ARKHAM_API_KEY",
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing env: ${missing.join(", ")}`);
  process.exit(1);
}
const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
if (!blobToken) {
  console.warn("⚠ BLOB_READ_WRITE_TOKEN not set — skipping Vercel Blob mirror");
}

const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const arkhamKey = process.env.ARKHAM_API_KEY;

async function upstash(path, init = {}) {
  const res = await fetch(`${redisUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${redisToken}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok)
    throw new Error(`Upstash ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function hashSnapshot(hashName, outFile) {
  console.log(`→ HGETALL ${hashName}`);
  const { result } = await upstash(`/hgetall/${hashName}`);
  // Upstash REST returns HGETALL as a flat [field, value, field, value, ...] array.
  const entries = [];
  for (let i = 0; i < result.length; i += 2) {
    const field = result[i];
    let value = result[i + 1];
    try {
      value = JSON.parse(value);
    } catch {
      // leave as string if not JSON
    }
    entries.push({ field, value });
  }
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(outFile, lines);
  console.log(
    `  ✓ ${entries.length} entries → ${outFile} (${lines.length} bytes)`,
  );
  return { count: entries.length, lines };
}

async function mirrorToBlob(localPath, lines) {
  if (!blobToken) return;
  const date = new Date().toISOString().slice(0, 10);
  const blobPath = `intel-marathon/baseline-${date}/${localPath.split("/").pop()}`;
  console.log(`→ put ${blobPath} to Vercel Blob`);
  const { url } = await put(blobPath, lines, {
    // Labels + reports contain auth-gated forensic data — the baseline must
    // mirror to a PRIVATE store. The script's BLOB_READ_WRITE_TOKEN must be
    // scoped to the private store (`store_YRYjMV97UAqjXYS6` per the daily
    // `address-labels-backup` cron); a public-store token will fail with
    // "This store does not exist."
    access: "private",
    addRandomSuffix: false,
    contentType: "application/x-ndjson",
    allowOverwrite: true,
    token: blobToken,
  });
  console.log(`  ✓ ${url}`);
}

async function arkhamHealthCheck() {
  console.log("→ Arkham GET /health");
  const res = await fetch(`${ARKHAM_BASE}/health`, {
    headers: { "API-Key": arkhamKey },
  });
  console.log(`  ${res.status} ${res.statusText}`);
  if (res.status === 401) {
    console.error("  ✗ key rejected (401). Marathon cannot proceed.");
    process.exit(2);
  }
  if (!res.ok) {
    console.error("  ✗ health check failed");
    process.exit(2);
  }
  console.log("  ✓ Arkham key is alive");

  // Also probe /chains to confirm Celo/Monad still unsupported (informational).
  console.log("→ Arkham GET /chains");
  const chainsRes = await fetch(`${ARKHAM_BASE}/chains`, {
    headers: { "API-Key": arkhamKey },
  });
  if (chainsRes.ok) {
    const chains = await chainsRes.json();
    console.log(`  ${chains.length} chains supported: ${chains.join(", ")}`);
    if (chains.includes("celo"))
      console.log("  ⚠ Celo IS supported now — Tier 1 could query ?chain=celo");
    if (chains.includes("monad")) console.log("  ⚠ Monad IS supported now");
  }
}

async function main() {
  const startedAt = Date.now();
  mkdirSync(OUT_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);

  const labelsFile = `${OUT_DIR}/baseline-${date}-labels.jsonl`;
  const reportsFile = `${OUT_DIR}/baseline-${date}-reports.jsonl`;

  const labels = await hashSnapshot("labels", labelsFile);
  const reports = await hashSnapshot("reports", reportsFile);

  await mirrorToBlob(labelsFile, labels.lines);
  await mirrorToBlob(reportsFile, reports.lines);

  await arkhamHealthCheck();

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("");
  console.log(`✓ Baseline done in ${elapsed}s.`);
  console.log(`  labels: ${labels.count} entries`);
  console.log(`  reports: ${reports.count} entries`);
  console.log(
    `  Backups: ${OUT_DIR}/baseline-${date}-*.jsonl${blobToken ? " (+ Vercel Blob)" : ""}`,
  );
}

main().catch((err) => {
  console.error("✗ FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
