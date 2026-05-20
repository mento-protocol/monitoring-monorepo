#!/usr/bin/env node
/**
 * Extraction #2b — Wealth snapshots (balances + portfolio history).
 *
 * For each top-priority Mento operator (cluster fleet, rebalancer, Foundation
 * safe, top traders), pull current `/balances/address/{addr}` + 4 portfolio
 * snapshots (now, -30d, -90d, -180d) via `/portfolio/address/{addr}?time=<ms>`.
 *
 * Standard bucket — fast.
 *
 * Persists combined record into intel_wealth hash keyed by address.
 */

import process from "node:process";
import { appendFileSync, mkdirSync } from "node:fs";

const ARKHAM_BASE = "https://api.arkm.com";
const OUT_DIR = ".intel-marathon";
const REQ_SPACING_MS = 60; // standard bucket
const RATE_LIMIT_BACKOFF_MS = 1500;
const PORTFOLIO_OFFSETS_DAYS = [0, 30, 90, 180];

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isValidAddress = (v) =>
  typeof v === "string" && /^0x[a-f0-9]{40}$/.test(v);

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

async function buildTargets() {
  const targets = new Map();
  targets.set(CLUSTER_7DC0_DEPLOYER, { sources: ["cluster-7dc0-deployer"] });
  for (const c of CLUSTER_7DC0_CONTRACTS)
    targets.set(c, { sources: ["cluster-7dc0-contract"] });
  targets.set(MENTO_REBALANCER, { sources: ["mento-rebalancer"] });
  targets.set(MENTO_FOUNDATION_SAFE, { sources: ["mento-foundation-safe"] });

  const reportKeys = await upstash(`/hkeys/reports`);
  for (const addr of reportKeys.result ?? []) {
    const lower = addr.toLowerCase();
    if (!isValidAddress(lower)) continue;
    if (targets.has(lower))
      targets.get(lower).sources.push("has-forensic-report");
    else targets.set(lower, { sources: ["has-forensic-report"] });
  }

  const deep = await upstash(`/hgetall/intel_deep`);
  const flat = deep.result ?? [];
  const ranked = [];
  for (let i = 0; i < flat.length; i += 2) {
    const addr = flat[i];
    try {
      const rec = JSON.parse(flat[i + 1]);
      let usd = 0;
      for (const list of Object.values(rec.counterparties ?? {})) {
        if (!Array.isArray(list)) continue;
        for (const cp of list) usd += cp?.usd ?? 0;
      }
      if (usd > 0) ranked.push({ addr, usd });
    } catch {}
  }
  ranked.sort((a, b) => b.usd - a.usd);
  for (const { addr } of ranked.slice(0, 30)) {
    if (targets.has(addr)) targets.get(addr).sources.push("top-deep-usd");
    else targets.set(addr, { sources: ["top-deep-usd"] });
  }
  return Array.from(targets.entries()).map(([address, meta]) => ({
    address,
    ...meta,
  }));
}

async function arkhamGet(path) {
  const res = await fetch(`${ARKHAM_BASE}${path}`, {
    headers: { "API-Key": arkhamKey },
    signal: AbortSignal.timeout(60_000),
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
  const rawFile = `${OUT_DIR}/extract-wealth-raw.jsonl`;

  console.log("→ Building target list...");
  const targets = await buildTargets();
  console.log(`  ${targets.length} unique targets`);

  const { result: doneArr } = await upstash(`/hkeys/intel_wealth`).catch(
    () => ({ result: [] }),
  );
  const done = new Set(doneArr ?? []);

  const now = Date.now();
  const timestamps = PORTFOLIO_OFFSETS_DAYS.map((d) => now - d * 86400_000);

  let success = 0,
    errors = 0,
    skipResume = 0;
  const writes = [];

  const MAX_RATE_LIMIT_RETRIES = 5;
  let lastIdx = -1;
  let retriesThisIdx = 0;
  for (let i = 0; i < targets.length; i++) {
    if (lastIdx !== i) {
      lastIdx = i;
      retriesThisIdx = 0;
    }
    const { address, sources } = targets[i];
    if (done.has(address)) {
      skipResume++;
      continue;
    }
    try {
      // Balances (1 call)
      const balances = await arkhamGet(`/balances/address/${address}`);
      await sleep(REQ_SPACING_MS);
      // Portfolio at 4 timestamps (4 calls)
      const portfolio = {};
      for (let t = 0; t < timestamps.length; t++) {
        const ts = timestamps[t];
        const r = await arkhamGet(`/portfolio/address/${address}?time=${ts}`);
        portfolio[`${PORTFOLIO_OFFSETS_DAYS[t]}d_ago`] = { ts, data: r.data };
        if (t < timestamps.length - 1) await sleep(REQ_SPACING_MS);
      }
      const record = {
        address,
        fetchedAt: new Date().toISOString(),
        sources,
        balances: balances.data,
        portfolio,
        version: 1,
      };
      let jsonStr = JSON.stringify(record);
      if (jsonStr.length > 49_000) {
        // Trim: drop balance details if too big.
        jsonStr = JSON.stringify({
          ...record,
          balances: { _truncated: true },
          _truncated: true,
        });
      }
      writes.push(["HSET", "intel_wealth", address, jsonStr]);
      success++;
      if (writes.length >= 5) await pipeline(writes.splice(0));
      appendFileSync(rawFile, JSON.stringify({ address, ts: now }) + "\n");
    } catch (err) {
      if (err.message === "ARKHAM_AUTH_FAIL") {
        console.error("✗ Auth fail — halting.");
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
        await sleep(RATE_LIMIT_BACKOFF_MS);
        i--;
        continue;
      }
      errors++;
      console.warn(`  ⚠ ${address}: ${err.message}`);
    }
    if ((i + 1) % 5 === 0) {
      const e = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `  [${i + 1}/${targets.length}] ok=${success} err=${errors} skipResume=${skipResume} elapsed=${e}s`,
      );
    }
    await sleep(REQ_SPACING_MS);
  }
  if (writes.length) await pipeline(writes);

  const e = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n✓ Wealth extraction done in ${e}s.`);
  console.log(`  targets:        ${targets.length}`);
  console.log(`  success:        ${success}`);
  console.log(`  errors:         ${errors}`);
  console.log(`  skipResume:     ${skipResume}`);
  console.log(`  raw:            ${rawFile}`);
}

main().catch((err) => {
  console.error("✗ FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
