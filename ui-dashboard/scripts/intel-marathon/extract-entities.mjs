#!/usr/bin/env node
/**
 * Extraction #1 — Entity reverse-mapping.
 *
 * Scans existing intel_deep + labels for every distinct Arkham entity slug
 * surfaced so far, then calls /intelligence/entity/{slug} for each. Persists
 * the full entity record (including the `addresses` list) into a new Upstash
 * hash `intel_entities` keyed by slug.
 *
 * Goal: frozen reverse-lookup. After Arkham access expires, we can still
 * answer "is this address Binance?" by checking set membership against the
 * cached entity address list.
 *
 * Usage:
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... ARKHAM_API_KEY=... \
 *   node ui-dashboard/scripts/intel-marathon/extract-entities.mjs
 */

import process from "node:process";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const ARKHAM_BASE = "https://api.arkm.com";
const OUT_DIR = ".intel-marathon";
const REQ_SPACING_MS = 60; // standard bucket
const RATE_LIMIT_BACKOFF_MS = 1500;

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

function extractSlugs(deepEntries, labelEntries) {
  const slugs = new Set();

  // From intel_deep: walk every nested arkhamEntity.id
  for (const raw of deepEntries) {
    try {
      const rec = JSON.parse(raw);
      // enriched: { chain: { arkhamEntity: { id } } }
      for (const perChain of Object.values(rec.enriched ?? {})) {
        const id = perChain?.arkhamEntity?.id;
        if (id) slugs.add(id);
      }
      // counterparties: { chain: [{ address: { arkhamEntity: { id } } }] }
      for (const chainList of Object.values(rec.counterparties ?? {})) {
        if (!Array.isArray(chainList)) continue;
        for (const cp of chainList) {
          const id = cp?.address?.arkhamEntity?.id;
          if (id) slugs.add(id);
        }
      }
      // entity: { id, name, ... } if fetched
      if (rec.entity?.id) slugs.add(rec.entity.id);
    } catch {
      /* skip malformed */
    }
  }

  // From labels: parse `slug:<id>` and `ctp:<id>` tags
  for (const raw of labelEntries) {
    try {
      const entry = JSON.parse(raw);
      for (const tag of entry.tags ?? []) {
        if (typeof tag !== "string") continue;
        if (tag.startsWith("slug:")) slugs.add(tag.slice(5));
        if (tag.startsWith("ctp:")) slugs.add(tag.slice(4));
      }
    } catch {
      /* skip */
    }
  }

  return Array.from(slugs).sort();
}

async function fetchEntity(slug) {
  const url = `${ARKHAM_BASE}/intelligence/entity/${encodeURIComponent(slug)}`;
  const res = await fetch(url, {
    headers: { "API-Key": arkhamKey },
    signal: AbortSignal.timeout(15_000),
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
  const rawFile = `${OUT_DIR}/extract-entities-raw.jsonl`;

  console.log("→ Scanning intel_deep + labels for entity slugs...");
  const [deepResp, labelResp] = await pipeline([
    ["HVALS", "intel_deep"],
    ["HVALS", "labels"],
  ]);
  const slugs = extractSlugs(deepResp.result ?? [], labelResp.result ?? []);
  console.log(`  found ${slugs.length} unique entity slugs`);

  // Filter out slugs we've already fetched (resume safety).
  const existing = await upstash(`/hkeys/intel_entities`).catch(() => ({
    result: [],
  }));
  const done = new Set(existing.result ?? []);
  const toFetch = slugs.filter((s) => !done.has(s));
  console.log(`  ${done.size} already cached, ${toFetch.length} to fetch`);

  let success = 0;
  let notFound = 0;
  let errors = 0;
  const writes = [];
  let totalAddresses = 0;

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
      const { status, data } = await fetchEntity(slug);
      appendFileSync(
        rawFile,
        JSON.stringify({ slug, status, data, ts: Date.now() }) + "\n",
      );
      if (status === 200 && data) {
        const record = {
          slug,
          fetchedAt: new Date().toISOString(),
          ...data,
        };
        const addrCount = (data.addresses ?? []).length;
        totalAddresses += addrCount;
        writes.push(["HSET", "intel_entities", slug, JSON.stringify(record)]);
        success++;
        if (writes.length >= 25) {
          await pipeline(writes.splice(0));
        }
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
        i--; // retry this slug
        continue;
      }
      errors++;
      console.warn(`  ⚠ ${slug}: ${err.message}`);
    }
    if ((i + 1) % 10 === 0) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `  [${i + 1}/${toFetch.length}] ok=${success} 404=${notFound} err=${errors} addrs=${totalAddresses} elapsed=${elapsed}s`,
      );
    }
    if (i < toFetch.length - 1) await sleep(REQ_SPACING_MS);
  }
  if (writes.length) await pipeline(writes);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("");
  console.log(`✓ Entity extraction done in ${elapsed}s.`);
  console.log(`  slugs scanned:    ${toFetch.length}`);
  console.log(`  successful:       ${success}`);
  console.log(`  404 (not found):  ${notFound}`);
  console.log(`  errors:           ${errors}`);
  console.log(`  addresses pulled: ${totalAddresses}`);
  console.log(`  raw:              ${rawFile}`);
}

main().catch((err) => {
  console.error("✗ FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
