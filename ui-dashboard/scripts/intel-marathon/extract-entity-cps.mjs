#!/usr/bin/env node
/**
 * Extraction #1b — Entity-to-entity counterparty graph.
 *
 * For each entity in arkham_entities, calls /counterparties/entity/{slug}
 * (HEAVY bucket, 1.1s pace). Persists chain-keyed counterparty arrays into
 * a new arkham_entity_cps hash. Captures Arkham's edge graph — who does
 * Binance/Squid/Uniswap interact with most — that's uniquely Arkham and
 * not derivable from any other source.
 */

import process from "node:process";
import { appendFileSync, mkdirSync } from "node:fs";

const ARKHAM_BASE = "https://api.arkm.com";
const OUT_DIR = ".intel-marathon";
const HEAVY_SPACING_MS = 1100;
const RATE_LIMIT_BACKOFF_MS = 2000;

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
  return res.json();
}

async function fetchEntityCps(slug) {
  const url = `${ARKHAM_BASE}/counterparties/entity/${encodeURIComponent(slug)}?limit=20&timeLast=30d`;
  const res = await fetch(url, {
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
  const rawFile = `${OUT_DIR}/extract-entity-cps-raw.jsonl`;

  console.log("→ Loading entity slugs from arkham_entities...");
  const { result: slugs } = await upstash(`/hkeys/arkham_entities`);
  console.log(`  ${slugs.length} entities cached`);

  // Resume: skip entities already fetched.
  const { result: doneArr } = await upstash(`/hkeys/arkham_entity_cps`).catch(
    () => ({ result: [] }),
  );
  const done = new Set(doneArr ?? []);
  const toFetch = slugs.filter((s) => !done.has(s));
  console.log(`  ${done.size} already cached, ${toFetch.length} to fetch`);

  let success = 0,
    notFound = 0,
    errors = 0,
    totalCps = 0;
  const writes = [];

  const MAX_RATE_LIMIT_RETRIES = 5;
  let lastIdx = -1;
  let retriesThisIdx = 0;
  for (let i = 0; i < toFetch.length; i++) {
    if (lastIdx !== i) {
      lastIdx = i;
      retriesThisIdx = 0;
    }
    const slug = toFetch[i];
    try {
      const { status, data } = await fetchEntityCps(slug);
      appendFileSync(
        rawFile,
        JSON.stringify({ slug, status, ts: Date.now() }) + "\n",
      );
      if (status === 200 && data) {
        let cpsCount = 0;
        for (const v of Object.values(data)) {
          if (Array.isArray(v)) cpsCount += v.length;
        }
        const record = {
          slug,
          fetchedAt: new Date().toISOString(),
          counterparties: data,
          cpsCount,
        };
        let jsonStr = JSON.stringify(record);
        if (jsonStr.length > 49_000) {
          // Trim each chain to top 10 if oversized.
          for (const chain of Object.keys(data)) {
            if (Array.isArray(data[chain]))
              data[chain] = data[chain].slice(0, 10);
          }
          jsonStr = JSON.stringify({
            ...record,
            counterparties: data,
            _truncated: true,
          });
        }
        writes.push(["HSET", "arkham_entity_cps", slug, jsonStr]);
        success++;
        totalCps += cpsCount;
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
            `  ⚠ ${slug}: gave up after ${MAX_RATE_LIMIT_RETRIES} 429 retries`,
          );
          continue;
        }
        console.warn(`  ⚠ 429 on ${slug}, backing off`);
        await sleep(RATE_LIMIT_BACKOFF_MS);
        i--;
        continue;
      }
      errors++;
      console.warn(`  ⚠ ${slug}: ${err.message}`);
    }
    if ((i + 1) % 10 === 0) {
      const e = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `  [${i + 1}/${toFetch.length}] ok=${success} 404=${notFound} err=${errors} cps=${totalCps} elapsed=${e}s`,
      );
    }
    if (i < toFetch.length - 1) await sleep(HEAVY_SPACING_MS);
  }
  if (writes.length) await pipeline(writes);

  const e = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n✓ Entity counterparty extraction done in ${e}s.`);
  console.log(`  entities:       ${toFetch.length}`);
  console.log(`  success:        ${success}`);
  console.log(`  404:            ${notFound}`);
  console.log(`  errors:         ${errors}`);
  console.log(`  total cps:      ${totalCps}`);
  console.log(`  raw:            ${rawFile}`);
}

main().catch((err) => {
  console.error("✗ FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
