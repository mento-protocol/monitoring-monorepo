#!/usr/bin/env node
/**
 * Tier 1 — bulk Arkham sweep of every distinct address that has interacted
 * with Mento, via /intelligence/address_enriched/{addr}/all. Persists into
 * Upstash `labels` hash (source: "arkham"), skipping manually-labeled addrs.
 *
 * Discovery extends ui-dashboard/src/lib/mento-address-discovery.ts
 * DISCOVERY_TARGETS with five sources the cron is missing.
 *
 * Resumes from .intel-marathon/tier1-progress-{chainId}.jsonl on restart.
 *
 * Usage:
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... ARKHAM_API_KEY=... \
 *   node ui-dashboard/scripts/intel-marathon/tier1-bulk-enrich.mjs --chain 42220
 *   node ui-dashboard/scripts/intel-marathon/tier1-bulk-enrich.mjs --chain 143
 */

import process from "node:process";
import {
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";

const ARKHAM_BASE = "https://api.arkm.com";
const HASURA_URL = "https://indexer.hyperindex.xyz/2f3dd15/v1/graphql";
const OUT_DIR = ".intel-marathon";
const PAGE_SIZE = 1000;
const HARD_PAGE_CAP = 100;
const REQ_SPACING_MS = 60; // standard bucket, ~16 req/s
const RATE_LIMIT_BACKOFF_MS = 1500;
const HIGH_CONFIDENCE = 0.85;
const HSET_BATCH = 100;

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
const chainArgIdx = args.indexOf("--chain");
if (chainArgIdx < 0 || !args[chainArgIdx + 1]) {
  console.error("Usage: --chain <chainId> (e.g. 42220 or 143)");
  process.exit(1);
}
const chainId = Number(args[chainArgIdx + 1]);
const limitArgIdx = args.indexOf("--limit");
const limitArg = limitArgIdx >= 0 ? Number(args[limitArgIdx + 1]) : Infinity;

// ---------------------------------------------------------------------------
// Discovery — superset of mento-address-discovery.ts DISCOVERY_TARGETS.
// Per-(table, field) tuple; chainIdColumn defaults to `chainId`.
// ---------------------------------------------------------------------------

const DISCOVERY_TARGETS = [
  // Existing cron targets (mirror DISCOVERY_TARGETS from lib).
  { table: "SwapEvent", field: "sender", chainIdColumn: "chainId" },
  { table: "SwapEvent", field: "recipient", chainIdColumn: "chainId" },
  { table: "SwapEvent", field: "caller", chainIdColumn: "chainId" },
  { table: "SwapEvent", field: "txTo", chainIdColumn: "chainId" },
  { table: "LiquidityEvent", field: "sender", chainIdColumn: "chainId" },
  { table: "LiquidityEvent", field: "recipient", chainIdColumn: "chainId" },
  { table: "RebalanceEvent", field: "sender", chainIdColumn: "chainId" },
  { table: "RebalanceEvent", field: "caller", chainIdColumn: "chainId" },
  { table: "LiquidityPosition", field: "address", chainIdColumn: "chainId" },
  { table: "OlsLiquidityEvent", field: "caller", chainIdColumn: "chainId" },
  { table: "BridgeTransfer", field: "sender", chainIdColumn: "sourceChainId" },
  { table: "BridgeTransfer", field: "recipient", chainIdColumn: "destChainId" },
  // NEW: marathon-specific extensions.
  { table: "TraderDailySnapshot", field: "trader", chainIdColumn: "chainId" },
  {
    table: "BrokerTraderDailySnapshot",
    field: "caller",
    chainIdColumn: "chainId",
  },
  { table: "BrokerSwapEvent", field: "caller", chainIdColumn: "chainId" },
  { table: "Trove", field: "owner", chainIdColumn: "chainId" },
  { table: "Pool", field: "rebalancerAddress", chainIdColumn: "chainId" },
];

// BridgeBridger has no chainId column (one row per cross-chain sender).
// Query it separately, no chain filter.
const CROSS_CHAIN_TARGETS = [{ table: "BridgeBridger", field: "sender" }];

const isValidAddress = (v) =>
  typeof v === "string" && /^0x[a-f0-9]{40}$/.test(v);

async function hasura(query, variables) {
  const res = await fetch(HASURA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Hasura ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.errors)
    throw new Error(`Hasura errors: ${JSON.stringify(body.errors)}`);
  return body.data;
}

async function fetchDistinct(target, chain) {
  const { table, field, chainIdColumn } = target;
  const filter = chainIdColumn
    ? `where: { ${chainIdColumn}: { _eq: $chainId } }`
    : "";
  const vars = chainIdColumn
    ? { chainId: chain, limit: PAGE_SIZE, offset: 0 }
    : { limit: PAGE_SIZE, offset: 0 };
  const all = new Set();
  for (let page = 0; page < HARD_PAGE_CAP; page++) {
    vars.offset = page * PAGE_SIZE;
    const query = `query Q($chainId: Int, $limit: Int!, $offset: Int!) {
      rows: ${table}(
        ${filter}
        distinct_on: [${field}]
        order_by: { ${field}: asc }
        limit: $limit
        offset: $offset
      ) {
        address: ${field}
      }
    }`;
    const data = await hasura(query, vars);
    const rows = data.rows ?? [];
    if (rows.length === 0) break;
    for (const r of rows) {
      const lower = r.address?.toLowerCase();
      if (lower && isValidAddress(lower)) all.add(lower);
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return Array.from(all);
}

async function discoverAll(chain) {
  console.log(`→ Discovery for chain ${chain}...`);
  const counts = {};
  const all = new Set();
  for (const target of DISCOVERY_TARGETS) {
    try {
      const found = await fetchDistinct(target, chain);
      counts[`${target.table}.${target.field}`] = found.length;
      for (const a of found) all.add(a);
      console.log(`  ${target.table}.${target.field}: ${found.length}`);
    } catch (err) {
      console.warn(`  ⚠ ${target.table}.${target.field}: ${err.message}`);
      counts[`${target.table}.${target.field}`] = `ERROR: ${err.message}`;
    }
  }
  // Cross-chain targets (no chain filter, run once per script invocation; we still
  // include them for both chains since they're chain-agnostic).
  for (const target of CROSS_CHAIN_TARGETS) {
    try {
      const found = await fetchDistinct(target, null);
      counts[`${target.table}.${target.field}`] = found.length;
      for (const a of found) all.add(a);
      console.log(
        `  ${target.table}.${target.field}: ${found.length} (cross-chain)`,
      );
    } catch (err) {
      console.warn(`  ⚠ ${target.table}.${target.field}: ${err.message}`);
    }
  }
  console.log(`→ Discovery total (deduped): ${all.size} addresses`);
  return { addresses: Array.from(all).sort(), counts };
}

// ---------------------------------------------------------------------------
// Upstash + existing-label filter
// ---------------------------------------------------------------------------

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

async function getLabels() {
  // HGETALL of the entire `labels` hash. Used to filter out manually-labeled
  // addresses (don't clobber). Per arkham.ts filterCandidates: in "new" mode,
  // only unlabeled addresses get enriched.
  const { result } = await upstash(`/hgetall/labels`);
  const map = {};
  for (let i = 0; i < result.length; i += 2) {
    const field = result[i];
    try {
      map[field] = JSON.parse(result[i + 1]);
    } catch {
      map[field] = result[i + 1];
    }
  }
  return map;
}

function filterCandidates(candidates, existing) {
  return candidates.flatMap((a) => {
    const address = a.toLowerCase();
    const current = existing[address];
    if (!current) return [address];
    return []; // labeled (manual or arkham) — skip
  });
}

// ---------------------------------------------------------------------------
// Arkham — fetch + map to AddressEntry, mirrors arkham.ts toAddressEntry().
// ---------------------------------------------------------------------------

async function fetchEnriched(address) {
  const url = new URL(
    `/intelligence/address_enriched/${address}/all`,
    ARKHAM_BASE,
  );
  url.searchParams.set("includeTags", "true");
  url.searchParams.set("includeEntityPredictions", "true");
  url.searchParams.set("includeClusters", "false");
  const res = await fetch(url, {
    headers: { "API-Key": arkhamKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return { status: 404, data: null };
  if (res.status === 401) throw new Error("ARKHAM_AUTH_FAIL");
  if (res.status === 429) throw new Error("ARKHAM_RATE_LIMITED");
  if (!res.ok) throw new Error(`arkham_http_${res.status}`);
  return { status: 200, data: await res.json() };
}

function toAddressEntry(data) {
  let label, entity, topPred;
  const tagSet = new Set();
  for (const perChain of Object.values(data)) {
    const trimmed = perChain.arkhamLabel?.name?.trim();
    if (!label && trimmed) label = trimmed;
    if (!entity && perChain.arkhamEntity?.name?.trim())
      entity = perChain.arkhamEntity;
    if (entity?.type) tagSet.add(entity.type);
    for (const t of perChain.tags ?? []) if (t.slug) tagSet.add(t.slug);
    for (const p of perChain.entityPredictions ?? []) {
      if (p.confidence < HIGH_CONFIDENCE) continue;
      if (!topPred || p.confidence > topPred.confidence) topPred = p;
    }
  }
  const name = (label || entity?.name?.trim() || topPred?.entityId || "").slice(
    0,
    200,
  );
  if (!name) return null;
  const note =
    !label && !entity && topPred
      ? `Arkham prediction (${Math.round(topPred.confidence * 100)}% confidence)`
      : undefined;
  return {
    name,
    tags: Array.from(tagSet)
      .slice(0, 20)
      .map((t) => String(t).slice(0, 50)),
    notes: note,
    isPublic: false,
    source: "arkham",
    updatedAt: new Date().toISOString(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();
  mkdirSync(OUT_DIR, { recursive: true });
  const rawFile = `${OUT_DIR}/tier1-raw-${chainId}.jsonl`;
  const progressFile = `${OUT_DIR}/tier1-progress-${chainId}.jsonl`;

  // Resume: load already-processed addresses from prior runs.
  const processed = new Set();
  if (existsSync(progressFile)) {
    const prior = readFileSync(progressFile, "utf8")
      .split("\n")
      .filter(Boolean);
    for (const line of prior) {
      try {
        const { address } = JSON.parse(line);
        if (address) processed.add(address);
      } catch {
        /* skip malformed */
      }
    }
    console.log(`→ Resuming: ${processed.size} addresses already processed`);
  }

  // Discovery
  const { addresses, counts } = await discoverAll(chainId);
  writeFileSync(
    `${OUT_DIR}/tier1-inventory-${chainId}.json`,
    JSON.stringify(
      { chainId, counts, totalDeduped: addresses.length },
      null,
      2,
    ),
  );

  // Filter against existing labels + already-processed.
  console.log(`→ Loading existing labels from Upstash...`);
  const existing = await getLabels();
  console.log(`  ${Object.keys(existing).length} entries currently in labels`);
  let candidates = filterCandidates(addresses, existing);
  candidates = candidates.filter((a) => !processed.has(a));
  if (candidates.length > limitArg) candidates = candidates.slice(0, limitArg);
  console.log(
    `→ ${candidates.length} candidates to enrich (after filtering existing + resume)`,
  );

  let attested = 0;
  let nullCount = 0;
  let errorCount = 0;
  const pendingWrites = [];
  let processedSinceLastFlush = 0;

  async function flushWrites() {
    if (pendingWrites.length === 0) return;
    const commands = pendingWrites.map((w) => [
      "HSET",
      "labels",
      w.address,
      JSON.stringify(w.entry),
    ]);
    await pipeline(commands);
    pendingWrites.length = 0;
  }

  for (let i = 0; i < candidates.length; i++) {
    const address = candidates[i];
    try {
      const { status, data } = await fetchEnriched(address);
      appendFileSync(
        rawFile,
        JSON.stringify({ address, status, data, ts: Date.now() }) + "\n",
      );
      appendFileSync(progressFile, JSON.stringify({ address, status }) + "\n");
      if (status === 404 || !data) {
        nullCount++;
      } else {
        const entry = toAddressEntry(data);
        if (entry) {
          // Merge with existing if it was an arkham-sourced refresh. For now, simple insert.
          const merged = { ...entry, createdAt: new Date().toISOString() };
          pendingWrites.push({ address, entry: merged });
          attested++;
          if (pendingWrites.length >= HSET_BATCH) await flushWrites();
        } else {
          nullCount++;
        }
      }
    } catch (err) {
      if (err.message === "ARKHAM_AUTH_FAIL") {
        console.error("✗ Arkham key rejected. Halting.");
        await flushWrites();
        process.exit(2);
      }
      if (err.message === "ARKHAM_RATE_LIMITED") {
        console.warn(
          `  ⚠ 429 on ${address}, backing off ${RATE_LIMIT_BACKOFF_MS}ms`,
        );
        await sleep(RATE_LIMIT_BACKOFF_MS);
        // Retry once
        try {
          const { status, data } = await fetchEnriched(address);
          appendFileSync(
            rawFile,
            JSON.stringify({ address, status, data, ts: Date.now() }) + "\n",
          );
          appendFileSync(
            progressFile,
            JSON.stringify({ address, status }) + "\n",
          );
          if (status === 200 && data) {
            const entry = toAddressEntry(data);
            if (entry) {
              pendingWrites.push({
                address,
                entry: { ...entry, createdAt: new Date().toISOString() },
              });
              attested++;
            } else {
              nullCount++;
            }
          } else {
            nullCount++;
          }
        } catch (retryErr) {
          errorCount++;
          appendFileSync(
            progressFile,
            JSON.stringify({ address, error: retryErr.message }) + "\n",
          );
        }
      } else {
        errorCount++;
        appendFileSync(
          progressFile,
          JSON.stringify({ address, error: err.message }) + "\n",
        );
      }
    }
    processedSinceLastFlush++;
    if (processedSinceLastFlush % 200 === 0) {
      await flushWrites();
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `  [${i + 1}/${candidates.length}] attested=${attested} null=${nullCount} errors=${errorCount} elapsed=${elapsed}s`,
      );
    }
    if (i < candidates.length - 1) await sleep(REQ_SPACING_MS);
  }

  await flushWrites();
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("");
  console.log(`✓ Tier 1 chain=${chainId} done in ${elapsed}s.`);
  console.log(`  candidates: ${candidates.length}`);
  console.log(`  attested:   ${attested}`);
  console.log(`  null:       ${nullCount}`);
  console.log(`  errors:     ${errorCount}`);
  console.log(`  raw:        ${rawFile}`);
}

main().catch((err) => {
  console.error("✗ FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
