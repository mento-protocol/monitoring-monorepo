#!/usr/bin/env node
/**
 * Extraction #2 — Transfer history snapshots.
 *
 * For each top-priority Mento operator EOA / contract, fetch the most recent
 * 100 transfers via /transfers/{addr}. Each transfer carries USD value,
 * counterparty address (with nested entity attribution), timestamp.
 *
 * Target list:
 *  - cluster-7dc08ec28f299c06 deployer EOA + 16 fleet contracts
 *  - 11 already-investigated forensic-report addresses (from `reports` hash)
 *  - The Mento Cross-Chain Rebalancer + Foundation Safe
 *  - Top N attested Mento traders from `intel_deep` (by counterparty USD)
 *
 * Persists to NEW Upstash hash `intel_transfers`, keyed by address.
 *
 * Usage:
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... ARKHAM_API_KEY=... \
 *   node ui-dashboard/scripts/intel-marathon/extract-transfers.mjs [--limit 50]
 */

import process from "node:process";
import { appendFileSync, mkdirSync } from "node:fs";

const ARKHAM_BASE = "https://api.arkm.com";
const OUT_DIR = ".intel-marathon";
const HEAVY_SPACING_MS = 1100; // heavy bucket 1 req/s + headroom
const RATE_LIMIT_BACKOFF_MS = 2000;
const TRANSFERS_PER_ADDR = 100;

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
const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const arkhamKey = process.env.ARKHAM_API_KEY;

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 50;

// Cluster-7dc08ec contracts (16) + deployer EOA.
const CLUSTER_7DC0_CONTRACTS = [
  "0xf184a8498f4bad5ca6ef538b72142411588792a3",
  "0xea99a75e309868a59074e9b0441c14ba62c6ea28",
  "0x953b7173200229f255f83b6f4fa448d753b79301",
  "0xf023c10a9adb0553ce07d37f367630e4e84a944e",
  "0x187c35dbbc8055b267303dd7b351e708f4c5d3bf",
  "0x9bfbcd07ea9c3cdc30057d7629beb589fe2d854d",
  "0xfe8237bcba52339d818c9c9c3c94481196e4b653",
  "0x35f629410baffd35c482a1f77cfb0ec2f0a75c76",
  "0x1bbcc3dad88fe33248a9ab6600fe72235c51d7ce",
  "0x48d5be40f43fd70ed9329dc0e83b8c5d3a3364f4",
  "0x93acb2d456edeffa2e2ea97efc4fa4d17c39d4b8",
  "0xef6956414006e161fca5f048331d91e472077e9b",
  "0x00d1cda22d867e2d2f22931b5567e93cc1e047cd",
  "0x2e73e4a7f4c2ee4fb5d5d2fd823821e3975237d7",
  "0x6f9fe2b0acf50874dcb49faefff62382381bf622",
  "0xc2068e03ca948f54348899eeda1417a901d76285",
];
const CLUSTER_7DC0_DEPLOYER = "0x7dc08ec28f299c062d2941de1f9cfb741df8f022";
const MENTO_REBALANCER = "0xaa8299fc6a685b5f9ce9bda8d0b3ea3d54731976";
const MENTO_FOUNDATION_SAFE = "0x87647780180b8f55980c7d3ffefe08a9b29e9ae1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isValidAddress = (v) =>
  typeof v === "string" && /^0x[a-f0-9]{40}$/.test(v);

async function upstash(path, init = {}) {
  const res = await fetch(`${redisUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${redisToken}`, ...(init.headers ?? {}) },
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
  const json = await res.json();
  // Upstash pipeline returns HTTP 200 even when individual commands fail; scan
  // each entry for a per-command .error so a silent HSET/HVALS failure can't
  // pass as empty success.
  for (let i = 0; i < json.length; i++) {
    if (json[i] && json[i].error) {
      throw new Error(
        `Upstash pipeline cmd[${i}] (${commands[i][0]}): ${json[i].error}`,
      );
    }
  }
  return json;
}

async function buildTargetList() {
  const targets = new Map(); // address → { sources: [], priority: number }

  // 1. cluster-7dc08ec deployer + 16 contracts (priority 1)
  targets.set(CLUSTER_7DC0_DEPLOYER, {
    priority: 1,
    sources: ["cluster-7dc0-deployer"],
  });
  for (const c of CLUSTER_7DC0_CONTRACTS) {
    targets.set(c, { priority: 1, sources: ["cluster-7dc0-contract"] });
  }

  // 2. Named targets (priority 1)
  targets.set(MENTO_REBALANCER, { priority: 1, sources: ["mento-rebalancer"] });
  targets.set(MENTO_FOUNDATION_SAFE, {
    priority: 1,
    sources: ["mento-foundation-safe"],
  });

  // 3. All 11+ addresses that already have forensic reports
  const reportKeys = await upstash(`/hkeys/reports`);
  for (const addr of reportKeys.result ?? []) {
    const lower = addr.toLowerCase();
    if (!isValidAddress(lower)) continue;
    if (targets.has(lower)) {
      targets.get(lower).sources.push("has-forensic-report");
    } else {
      targets.set(lower, { priority: 2, sources: ["has-forensic-report"] });
    }
  }

  // 4. Top attested addresses from intel_deep — pick by counterparty USD volume.
  const deep = await upstash(`/hgetall/intel_deep`);
  const flat = deep.result ?? [];
  const ranked = [];
  for (let i = 0; i < flat.length; i += 2) {
    const addr = flat[i];
    try {
      const rec = JSON.parse(flat[i + 1]);
      let totalUsd = 0;
      for (const chainList of Object.values(rec.counterparties ?? {})) {
        if (!Array.isArray(chainList)) continue;
        for (const cp of chainList) totalUsd += cp?.usd ?? 0;
      }
      if (totalUsd > 0) ranked.push({ addr, totalUsd });
    } catch {
      /* skip */
    }
  }
  ranked.sort((a, b) => b.totalUsd - a.totalUsd);
  for (const { addr, totalUsd } of ranked.slice(0, 30)) {
    if (targets.has(addr)) {
      targets.get(addr).sources.push("top-deep-usd");
    } else {
      targets.set(addr, { priority: 3, sources: ["top-deep-usd"], totalUsd });
    }
  }

  return Array.from(targets.entries())
    .map(([address, meta]) => ({ address, ...meta }))
    .sort((a, b) => a.priority - b.priority);
}

async function fetchTransfers(address) {
  // Per Arkham API: GET /transfers?base=<addr>&limit=N (not /transfers/<addr>; that returns 405).
  const url = `${ARKHAM_BASE}/transfers?base=${address}&limit=${TRANSFERS_PER_ADDR}`;
  const res = await fetch(url, {
    headers: { "API-Key": arkhamKey },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) return { status: 404, data: null };
  if (res.status === 401) throw new Error("ARKHAM_AUTH_FAIL");
  if (res.status === 429) throw new Error("ARKHAM_RATE_LIMITED");
  if (!res.ok)
    throw new Error(
      `arkham_http_${res.status}: ${await res.text().catch(() => "")}`,
    );
  return { status: 200, data: await res.json() };
}

async function main() {
  const startedAt = Date.now();
  mkdirSync(OUT_DIR, { recursive: true });
  const rawFile = `${OUT_DIR}/extract-transfers-raw.jsonl`;

  console.log("→ Building target list...");
  const ranked = await buildTargetList();
  const queue = ranked.slice(0, limit);
  console.log(
    `  total candidates: ${ranked.length}; processing top ${queue.length}`,
  );

  // Filter out already-fetched.
  const existing = await upstash(`/hkeys/intel_transfers`).catch(() => ({
    result: [],
  }));
  const done = new Set(existing.result ?? []);

  let success = 0;
  let notFound = 0;
  let errors = 0;
  let totalTransfers = 0;
  let skipResume = 0;
  const writes = [];

  const MAX_RATE_LIMIT_RETRIES = 5;
  let lastIdx = -1;
  let retriesThisIdx = 0;
  for (let i = 0; i < queue.length; i++) {
    if (lastIdx !== i) {
      lastIdx = i;
      retriesThisIdx = 0;
    }
    const { address } = queue[i];
    if (done.has(address)) {
      skipResume++;
      continue;
    }
    try {
      const { status, data } = await fetchTransfers(address);
      const transferCount = Array.isArray(data?.transfers)
        ? data.transfers.length
        : 0;
      appendFileSync(
        rawFile,
        JSON.stringify({ address, status, transferCount, ts: Date.now() }) +
          "\n",
      );
      if (status === 200 && data) {
        const record = {
          address,
          fetchedAt: new Date().toISOString(),
          transferCount,
          ...data,
        };
        let jsonStr = JSON.stringify(record);
        if (jsonStr.length > 49_000) {
          // Trim transfers to fit under 50KB cap.
          const trimmed = (data.transfers ?? []).slice(0, 50);
          jsonStr = JSON.stringify({
            ...record,
            transfers: trimmed,
            _truncated: true,
          });
        }
        writes.push([
          "HSET",
          "intel_transfers",
          address.toLowerCase(),
          jsonStr,
        ]);
        success++;
        totalTransfers += transferCount;
        if (writes.length >= 10) await pipeline(writes.splice(0));
      } else {
        notFound++;
      }
    } catch (err) {
      if (err.message === "ARKHAM_AUTH_FAIL") {
        console.error("✗ Arkham key rejected — halting.");
        if (writes.length) await pipeline(writes);
        process.exit(2);
      }
      if (err.message === "ARKHAM_RATE_LIMITED") {
        if (++retriesThisIdx > MAX_RATE_LIMIT_RETRIES) {
          errors++;
          console.warn(
            `  ⚠ ${address}: gave up after ${MAX_RATE_LIMIT_RETRIES} 429 retries`,
          );
          continue;
        }
        console.warn(`  ⚠ 429 on ${address}, backing off`);
        await sleep(RATE_LIMIT_BACKOFF_MS);
        i--; // retry
        continue;
      }
      errors++;
      console.warn(`  ⚠ ${address}: ${err.message}`);
    }
    if ((i + 1) % 5 === 0) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `  [${i + 1}/${queue.length}] ok=${success} 404=${notFound} err=${errors} xfers=${totalTransfers} skipResume=${skipResume} elapsed=${elapsed}s`,
      );
    }
    await sleep(HEAVY_SPACING_MS);
  }
  if (writes.length) await pipeline(writes);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("");
  console.log(`✓ Transfer extraction done in ${elapsed}s.`);
  console.log(`  candidates:    ${queue.length}`);
  console.log(`  success:       ${success}`);
  console.log(`  404:           ${notFound}`);
  console.log(`  errors:        ${errors}`);
  console.log(`  skipResume:    ${skipResume}`);
  console.log(`  transfers:     ${totalTransfers}`);
  console.log(`  raw:           ${rawFile}`);
}

main().catch((err) => {
  console.error("✗ FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
