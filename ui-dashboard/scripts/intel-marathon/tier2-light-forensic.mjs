#!/usr/bin/env node
/**
 * Tier 2 — light forensic. For each prioritized address, fetch:
 *  - /counterparties/address/{addr}?flow=either&limit=20&timeLast=30d (heavy 1/s)
 *  - conditional /intelligence/entity/{slug} if Tier 1 surfaced an entity
 *  - conditional /intelligence/contract/{addr}?chain=… if contract:true on a supported chain
 *
 * Persists derived tags into `labels` hash + raw JSON into NEW `intel_deep` hash.
 *
 * Candidate set (in priority order):
 *  1. cluster-7dc08ec callers (top N from Hasura SwapEvent where txTo in 16 cluster contracts)
 *  2. labels hash entries with source: "arkham" from Tier 1
 *  3. Top traders by USD volume from TraderDailySnapshot + BrokerTraderDailySnapshot
 *  4. Top bridgers by totalSentUsd from BridgeBridger
 *
 * Usage:
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... ARKHAM_API_KEY=... \
 *   node ui-dashboard/scripts/intel-marathon/tier2-light-forensic.mjs --limit 200
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
const HEAVY_SPACING_MS = 1100; // heavy bucket = 1/s, leave headroom
const STD_SPACING_MS = 60;
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

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 200;
const allLabels = args.includes("--all-labels");

// Cluster-7dc08ec contract addresses (from indexer-envio/config/aggregators.json).
// Used to identify high-value callers via SwapEvent.txTo filter.
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

// Chains Arkham supports as of 2026-04 (per arkham SKILL.md).
const ARKHAM_CHAINS = new Set([
  "ethereum",
  "polygon",
  "bsc",
  "optimism",
  "avalanche",
  "arbitrum_one",
  "base",
  "bitcoin",
  "tron",
  "flare",
  "solana",
  "ton",
  "dogecoin",
  "zcash",
  "hyperevm",
]);

const isValidAddress = (v) =>
  typeof v === "string" && /^0x[a-f0-9]{40}$/.test(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Upstash
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

async function getLabels() {
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

async function hexistsArkhamDeep(addr) {
  const { result } = await upstash(`/hexists/intel_deep/${addr.toLowerCase()}`);
  return result === 1;
}

// ---------------------------------------------------------------------------
// Hasura
// ---------------------------------------------------------------------------

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

// Top traders by aggregated USD volume across v3 + v2 broker paths.
// Pulls the top-volume DAILY snapshot rows and accumulates per trader to dedup
// addresses with activity on multiple days/pools.
async function fetchTopTraders(limit) {
  const out = new Map(); // address → {volumeWei, source}
  const sources = [
    { table: "TraderDailySnapshot", addrField: "trader" },
    { table: "BrokerTraderDailySnapshot", addrField: "caller" },
  ];
  for (const { table, addrField } of sources) {
    try {
      const q = `query Q($limit: Int!) {
        rows: ${table}(
          where: { isSystemAddress: { _eq: false } }
          order_by: { volumeUsdWei: desc }
          limit: $limit
        ) {
          ${addrField}
          volumeUsdWei
        }
      }`;
      // Pull 1k rows per source (Hasura cap), accumulate per trader.
      const data = await hasura(q, { limit: 1000 });
      for (const r of data.rows ?? []) {
        const addr = r[addrField]?.toLowerCase();
        if (!isValidAddress(addr)) continue;
        const vol = BigInt(r.volumeUsdWei ?? "0");
        const prev = out.get(addr) ?? { volumeWei: 0n };
        out.set(addr, { volumeWei: prev.volumeWei + vol });
      }
    } catch (err) {
      console.warn(`  ⚠ ${table}: ${err.message}`);
    }
  }
  return Array.from(out.entries())
    .sort((a, b) => (b[1].volumeWei > a[1].volumeWei ? 1 : -1))
    .slice(0, limit)
    .map(([addr, meta]) => ({ address: addr, ...meta, source: "top-trader" }));
}

async function fetchTopBridgers(limit) {
  try {
    // totalSentUsd is a String in the schema — sort by totalSentCount (Int) instead.
    const q = `query Q($limit: Int!) {
      rows: BridgeBridger(
        order_by: { totalSentCount: desc }
        limit: $limit
      ) {
        sender
        totalSentUsd
        totalSentCount
      }
    }`;
    const data = await hasura(q, { limit });
    return (data.rows ?? [])
      .filter((r) => isValidAddress(r.sender?.toLowerCase()))
      .map((r) => ({
        address: r.sender.toLowerCase(),
        source: "top-bridger",
        totalSentUsd: r.totalSentUsd,
        totalSentCount: r.totalSentCount,
      }));
  } catch (err) {
    console.warn(`  ⚠ BridgeBridger: ${err.message}`);
    return [];
  }
}

async function fetchClusterCallers(limit) {
  try {
    // SwapEvent.caller where txTo ∈ cluster-7dc08ec contracts. Each chain.
    const q = `query Q($txTos: [String!]!, $limit: Int!) {
      rows: SwapEvent(
        where: { txTo: { _in: $txTos } }
        distinct_on: [caller]
        limit: $limit
      ) {
        caller
        txTo
        chainId
      }
    }`;
    const data = await hasura(q, { txTos: CLUSTER_7DC0_CONTRACTS, limit });
    const seen = new Set();
    return (data.rows ?? [])
      .filter((r) => {
        const a = r.caller?.toLowerCase();
        if (!isValidAddress(a) || seen.has(a)) return false;
        seen.add(a);
        return true;
      })
      .map((r) => ({
        address: r.caller.toLowerCase(),
        source: "cluster-7dc08ec-caller",
      }));
  } catch (err) {
    console.warn(`  ⚠ SwapEvent cluster lookup: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Arkham
// ---------------------------------------------------------------------------

async function arkhamGet(path) {
  const res = await fetch(`${ARKHAM_BASE}${path}`, {
    headers: { "API-Key": arkhamKey },
    signal: AbortSignal.timeout(20_000),
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

async function fetchCounterparties(address) {
  // Per testing on Binance hot wallet: flow=either/all/both all return 400.
  // Omitting `flow` returns both directions, grouped by chain (top-level keys).
  const params = new URLSearchParams({
    limit: "20",
    timeLast: "30d",
  });
  return arkhamGet(`/counterparties/address/${address}?${params}`);
}

async function fetchEntity(slug) {
  return arkhamGet(`/intelligence/entity/${encodeURIComponent(slug)}`);
}

async function fetchContract(address, chain) {
  // Documented shape is /intelligence/contract/{chain}/{address}; the prior
  // ?chain= variant 404'd silently because the surrounding catch absorbed it.
  return arkhamGet(
    `/intelligence/contract/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`,
  );
}

// ---------------------------------------------------------------------------
// Derive tags + name from combined Arkham data.
// ---------------------------------------------------------------------------

function bucketVolume(usd) {
  if (!usd || usd <= 0) return null;
  if (usd >= 1_000_000_000) return "volume:>1b";
  if (usd >= 100_000_000) return "volume:>100m";
  if (usd >= 10_000_000) return "volume:>10m";
  if (usd >= 1_000_000) return "volume:>1m";
  if (usd >= 100_000) return "volume:>100k";
  return null;
}

function deriveTags(enriched, counterparties) {
  const tags = new Set();
  let name = null;
  let entitySlug = null;
  let contractFlag = false;

  if (enriched) {
    for (const perChain of Object.values(enriched)) {
      if (!name && perChain.arkhamLabel?.name?.trim())
        name = perChain.arkhamLabel.name.trim();
      if (!name && perChain.arkhamEntity?.name?.trim())
        name = perChain.arkhamEntity.name.trim();
      if (!entitySlug && perChain.arkhamEntity?.id)
        entitySlug = perChain.arkhamEntity.id;
      if (perChain.arkhamEntity?.type)
        tags.add(`entity:${perChain.arkhamEntity.type}`);
      if (perChain.arkhamEntity?.id)
        tags.add(`slug:${perChain.arkhamEntity.id}`);
      for (const t of perChain.tags ?? []) if (t.slug) tags.add(t.slug);
      if (perChain.contract === true) contractFlag = true;
    }
  }

  if (counterparties) {
    // Counterparties response is keyed by chain: { ethereum: [...], polygon: [...] }.
    // Each item: { address: {...nested addr obj...}, usd?, transactionCount?, ... }.
    const all = [];
    for (const chainList of Object.values(counterparties)) {
      if (Array.isArray(chainList)) all.push(...chainList);
    }
    // Sort by USD desc, pick top 3 with resolved entity.
    const sorted = all.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
    let added = 0;
    for (const cp of sorted) {
      if (added >= 3) break;
      const slug = cp.address?.arkhamEntity?.id;
      if (slug) {
        tags.add(`ctp:${slug}`);
        added++;
      }
    }
  }

  if (contractFlag) tags.add("type:contract");

  return {
    name: name?.slice(0, 200) ?? null,
    tags: Array.from(tags)
      .slice(0, 20)
      .map((t) => String(t).slice(0, 50)),
    entitySlug,
    contractFlag,
  };
}

function arkhamSupportedChain(enriched) {
  if (!enriched) return null;
  for (const [chain, perChain] of Object.entries(enriched)) {
    if (ARKHAM_CHAINS.has(chain) && perChain.contract === true) return chain;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function buildCandidateSet() {
  console.log("→ Building candidate set...");
  const candidates = new Map(); // address → metadata{}

  // 1. Cluster-7dc08ec callers (high priority).
  const cluster = await fetchClusterCallers(500);
  console.log(`  cluster-7dc08ec callers: ${cluster.length}`);
  for (const c of cluster) {
    if (!candidates.has(c.address))
      candidates.set(c.address, { priority: 1, sources: [c.source] });
  }
  // Always include the deployer EOA itself (named target).
  if (!candidates.has(CLUSTER_7DC0_DEPLOYER)) {
    candidates.set(CLUSTER_7DC0_DEPLOYER, {
      priority: 1,
      sources: ["cluster-7dc08ec-deployer"],
    });
  }

  // 2. source=arkham entries from labels (Tier 1 success).
  const labels = await getLabels();
  let arkhamSourced = 0;
  for (const [addr, entry] of Object.entries(labels)) {
    if (
      entry?.source === "arkham" ||
      (Array.isArray(entry?.tags) && entry.tags.includes("arkham"))
    ) {
      arkhamSourced++;
      if (candidates.has(addr)) {
        candidates.get(addr).sources.push("tier1-attested");
      } else {
        candidates.set(addr, { priority: 2, sources: ["tier1-attested"] });
      }
    }
  }
  console.log(`  Tier 1 attested (source=arkham): ${arkhamSourced}`);

  // 3. Top traders by USD volume.
  const traders = await fetchTopTraders(200);
  console.log(`  top traders (combined v3+v2, last 90d): ${traders.length}`);
  for (const t of traders) {
    if (candidates.has(t.address)) {
      candidates.get(t.address).sources.push(t.source);
    } else {
      candidates.set(t.address, {
        priority: 3,
        sources: [t.source],
        volumeWei: String(t.volumeWei),
      });
    }
  }

  // 4. Top bridgers.
  const bridgers = await fetchTopBridgers(100);
  console.log(`  top bridgers: ${bridgers.length}`);
  for (const b of bridgers) {
    if (candidates.has(b.address)) {
      candidates.get(b.address).sources.push(b.source);
    } else {
      candidates.set(b.address, {
        priority: 3,
        sources: [b.source],
        totalSentUsd: b.totalSentUsd,
      });
    }
  }

  // 5. --all-labels: add EVERY address from labels hash (priority 5 — last).
  // Catches manual labels, MiniPay users, etc. that aren't in the curated sources above.
  if (allLabels) {
    let added = 0;
    for (const addr of Object.keys(labels)) {
      if (!candidates.has(addr)) {
        candidates.set(addr, { priority: 5, sources: ["all-labels"] });
        added++;
      }
    }
    console.log(`  --all-labels: +${added} catch-all labels`);
  }

  // Sort by priority asc (1=highest), then by # of sources desc (multi-source signals high relevance).
  const ranked = Array.from(candidates.entries())
    .map(([address, meta]) => ({ address, ...meta }))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.sources.length - a.sources.length;
    });

  console.log(`  TOTAL deduped: ${ranked.length}`);
  return ranked;
}

async function main() {
  const startedAt = Date.now();
  mkdirSync(OUT_DIR, { recursive: true });
  const rawFile = `${OUT_DIR}/tier2-raw.jsonl`;
  const progressFile = `${OUT_DIR}/tier2-progress.jsonl`;

  // Resume: skip addresses already in intel_deep.
  const ranked = await buildCandidateSet();
  writeFileSync(
    `${OUT_DIR}/tier2-candidates.json`,
    JSON.stringify(ranked, null, 2),
  );

  // Filter to limit, sliced after priority sort.
  const queue = ranked.slice(0, limit);
  console.log(`→ Will process ${queue.length} addresses (limit=${limit})`);

  // Load existing labels once for tag merge.
  const existingLabels = await getLabels();

  let processed = 0;
  let attested = 0;
  let nullCount = 0;
  let errorCount = 0;
  let skipResume = 0;

  for (const candidate of queue) {
    const address = candidate.address;

    // Resume check
    if (await hexistsArkhamDeep(address)) {
      skipResume++;
      continue;
    }

    // Fetch counterparties (heavy bucket).
    let cpResult = null;
    let cpError = null;
    try {
      const r = await fetchCounterparties(address);
      cpResult = r.data;
      if (r.status === 404) nullCount++;
    } catch (err) {
      if (err.message === "ARKHAM_AUTH_FAIL") {
        console.error("✗ Arkham key rejected. Halting.");
        process.exit(2);
      }
      if (err.message === "ARKHAM_RATE_LIMITED") {
        console.warn(
          `  ⚠ 429 on ${address}, backing off ${RATE_LIMIT_BACKOFF_MS}ms`,
        );
        await sleep(RATE_LIMIT_BACKOFF_MS);
        try {
          const r = await fetchCounterparties(address);
          cpResult = r.data;
        } catch (retryErr) {
          cpError = retryErr.message;
        }
      } else {
        cpError = err.message;
      }
    }

    // Pull existing enriched from labels hash (Tier 1 output) for the address.
    let enrichedFromTier1 = null;
    const existing = existingLabels[address];
    if (existing?.source === "arkham") {
      enrichedFromTier1 = { _fromLabels: existing };
    }

    // Re-fetch enriched if we don't have it AND we found counterparties (cheap; std bucket).
    let enriched = null;
    if (cpResult) {
      try {
        const url = new URL(
          `/intelligence/address_enriched/${address}/all`,
          ARKHAM_BASE,
        );
        url.searchParams.set("includeTags", "true");
        url.searchParams.set("includeEntityPredictions", "true");
        url.searchParams.set("includeClusters", "false");
        const r = await fetch(url, {
          headers: { "API-Key": arkhamKey },
          signal: AbortSignal.timeout(15_000),
        });
        if (r.ok) enriched = await r.json();
        await sleep(STD_SPACING_MS);
      } catch (err) {
        // Soft-fail — enriched is optional supplement.
      }
    }

    // Conditional /entity (standard bucket).
    let entityData = null;
    const derived = deriveTags(enriched, cpResult);
    if (derived.entitySlug) {
      try {
        const r = await fetchEntity(derived.entitySlug);
        entityData = r.data;
        await sleep(STD_SPACING_MS);
      } catch {
        /* soft-fail */
      }
    }

    // Conditional /contract (standard bucket).
    let contractData = null;
    const contractChain = arkhamSupportedChain(enriched);
    if (contractChain) {
      try {
        const r = await fetchContract(address, contractChain);
        contractData = r.data;
        await sleep(STD_SPACING_MS);
      } catch {
        /* soft-fail */
      }
    }

    // Build the deep record.
    const deepRecord = {
      address,
      fetchedAt: new Date().toISOString(),
      candidate,
      enriched,
      counterparties: cpResult,
      entity: entityData,
      contract: contractData,
      error: cpError,
      version: 1,
    };
    let deepJson = JSON.stringify(deepRecord);
    if (deepJson.length > 49_000) {
      // Drop bulky entityPredictions to fit under 50KB cap.
      if (deepRecord.enriched) {
        for (const perChain of Object.values(deepRecord.enriched)) {
          delete perChain.entityPredictions;
          delete perChain.clusterIds;
        }
      }
      deepJson = JSON.stringify(deepRecord);
    }

    // Update labels entry — merge derived tags + name into existing or create.
    if (derived.name || derived.tags.length > 0) {
      const existingEntry = existingLabels[address];
      // Preserve manual entries (source !== arkham).
      const isManual =
        existingEntry &&
        existingEntry.source !== "arkham" &&
        !(
          Array.isArray(existingEntry.tags) &&
          existingEntry.tags.includes("arkham")
        );
      if (!isManual) {
        const mergedTags = new Set([
          ...(existingEntry?.tags ?? []),
          ...derived.tags,
        ]);
        const newEntry = {
          name: existingEntry?.name || derived.name || "(unknown)",
          tags: Array.from(mergedTags)
            .slice(0, 20)
            .map((t) => String(t).slice(0, 50)),
          notes: existingEntry?.notes ?? null,
          isPublic: existingEntry?.isPublic ?? false,
          source: "arkham",
          createdAt: existingEntry?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await pipeline([
          ["HSET", "labels", address.toLowerCase(), JSON.stringify(newEntry)],
          ["HSET", "intel_deep", address.toLowerCase(), deepJson],
        ]);
        existingLabels[address] = newEntry;
        if (derived.name) attested++;
      } else {
        // Manual label — don't touch labels, but store deep data.
        await pipeline([
          ["HSET", "intel_deep", address.toLowerCase(), deepJson],
        ]);
      }
    } else {
      // No derived attribution — still store deep for completeness.
      await pipeline([["HSET", "intel_deep", address.toLowerCase(), deepJson]]);
      nullCount++;
    }

    appendFileSync(rawFile, deepJson + "\n");
    appendFileSync(
      progressFile,
      JSON.stringify({
        address,
        attested: Boolean(derived.name),
        ts: Date.now(),
      }) + "\n",
    );

    processed++;
    if (processed % 10 === 0) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `  [${processed}/${queue.length}] attested=${attested} null=${nullCount} errors=${errorCount} skipResume=${skipResume} elapsed=${elapsed}s`,
      );
    }

    // Heavy-bucket pacing.
    await sleep(HEAVY_SPACING_MS);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("");
  console.log(`✓ Tier 2 done in ${elapsed}s.`);
  console.log(`  processed:    ${processed}`);
  console.log(`  attested:     ${attested}`);
  console.log(`  null:         ${nullCount}`);
  console.log(`  errors:       ${errorCount}`);
  console.log(`  skipResume:   ${skipResume}`);
  console.log(`  raw:          ${rawFile}`);
}

main().catch((err) => {
  console.error("✗ FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
