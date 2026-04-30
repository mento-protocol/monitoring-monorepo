#!/usr/bin/env node
/**
 * MiniPay bulk-seed: ingest the full Dune attestation set into Upstash Redis.
 *
 * The /api/minipay/sync route can't do the first-run backfill — Dune query
 * 7404332 returns ~16M rows / ~800 MB, which exceeds Vercel's 800s function
 * cap. Run this once locally to seed `minipay:users` + persist `minipay:lastBlock`.
 * Subsequent daily syncs (cron 03:30 UTC) hit the incremental path and finish
 * in seconds.
 *
 * Usage:
 *   DUNE_API_KEY=... \
 *   UPSTASH_REDIS_REST_URL=... \
 *   UPSTASH_REDIS_REST_TOKEN=... \
 *   node ui-dashboard/scripts/minipay-bulk-seed.mjs
 *
 * Idempotent: SADD is a no-op for existing members. Safe to re-run after
 * partial failures — re-pulls Dune from `lastBlock=0` and re-SADDs everything;
 * Redis dedup makes this cheap.
 */

import process from "node:process";

const DUNE_BASE = "https://api.dune.com";
const DUNE_QUERY_ID = 7404332;
const PAGE_SIZE = 10_000; // Dune supports up to 32k; 10k keeps response sizes ~5 MB
const SADD_CHUNK = 1000; // Upstash REST command-size friendly
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_ATTEMPTS = 240; // 20 min for the cold-cache execution

// Sharded over the first nibble of each address — matches `src/lib/minipay.ts`.
// Single Upstash key has a 100 MB cap; 16 shards keep each well under it.
const USERS_KEY_PREFIX = "minipay:users:";
const SHARD_NIBBLES = "0123456789abcdef";
function shardKey(address) {
  return USERS_KEY_PREFIX + address[2];
}
const LAST_BLOCK_KEY = "minipay:lastBlock";

const apiKey = process.env.DUNE_API_KEY;
const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!apiKey || !redisUrl || !redisToken) {
  console.error(
    "Missing env: DUNE_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN",
  );
  process.exit(1);
}

// Allow reusing a previous execution_id to skip the 78s execute step.
const REUSE_EXEC_ID = process.argv[2] ?? null;

function isValidAddress(value) {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
}

// Per-request deadlines mirror `src/lib/minipay.ts`. Without these, a
// TLS-stalled fetch could hang the script indefinitely.
const REQUEST_TIMEOUT_MS = 60_000;

async function dune(path, init = {}) {
  const res = await fetch(`${DUNE_BASE}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      "X-Dune-API-Key": apiKey,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Dune ${path} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function upstashFetch(path, init = {}) {
  const res = await fetch(`${redisUrl}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${redisToken}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Upstash ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function executeQuery(lastBlock) {
  const body = await dune(`/api/v1/query/${DUNE_QUERY_ID}/execute`, {
    method: "POST",
    body: JSON.stringify({
      query_parameters: { lastBlock: String(lastBlock) },
    }),
  });
  console.log(`> Dune execution started: ${body.execution_id}`);
  return body.execution_id;
}

async function pollUntilComplete(executionId) {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
    const body = await dune(`/api/v1/execution/${executionId}/status`);
    if (body.is_execution_finished) {
      if (body.state === "QUERY_STATE_COMPLETED") {
        console.log(
          `> Dune ready: ${body.result_metadata?.row_count ?? "?"} rows, ` +
            `${body.execution_time_millis ?? "?"}ms execution`,
        );
        return;
      }
      throw new Error(`Dune execution ended in state ${body.state}`);
    }
    if (attempt % 6 === 0) {
      // Once per ~30s
      console.log(`  …still ${body.state} (attempt ${attempt + 1})`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Dune did not complete within ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS}ms`,
  );
}

async function fetchPage(executionId, offset) {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    ...(offset > 0 ? { offset: String(offset) } : {}),
  });
  return dune(`/api/v1/execution/${executionId}/results?${params}`);
}

// Upstash REST pipeline can return HTTP 200 with per-command `{ error: ... }`
// entries (e.g. when a single SADD trips the 100 MB record limit). Surface
// those so we don't silently lose writes.
function checkPipelineResults(results, commands) {
  const failed = [];
  for (let i = 0; i < results.length; i += 1) {
    if (results[i]?.error) {
      const cmd = commands[i]?.[0] ?? "?";
      const key = commands[i]?.[1] ?? "?";
      failed.push(`${cmd} ${key}: ${results[i].error}`);
    }
  }
  if (failed.length > 0) {
    throw new Error(`Upstash pipeline errors:\n  ${failed.join("\n  ")}`);
  }
}

async function pipeline(commands) {
  const results = await upstashFetch(`/pipeline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  checkPipelineResults(results, commands);
  return results;
}

async function sadd(addresses) {
  if (addresses.length === 0) return 0;
  // Bucket by shard (first hex nibble), chunk each shard, pipeline together.
  const buckets = new Map();
  for (const a of addresses) {
    const k = shardKey(a);
    let list = buckets.get(k);
    if (!list) {
      list = [];
      buckets.set(k, list);
    }
    list.push(a);
  }
  const commands = [];
  for (const [key, members] of buckets) {
    for (let i = 0; i < members.length; i += SADD_CHUNK) {
      commands.push(["SADD", key, ...members.slice(i, i + SADD_CHUNK)]);
    }
  }
  const results = await pipeline(commands);
  return results.reduce((sum, r) => sum + (Number(r.result) || 0), 0);
}

async function setLastBlock(block) {
  await upstashFetch(`/set/${LAST_BLOCK_KEY}/${block}`);
}

async function scard() {
  const commands = SHARD_NIBBLES.split("").map((n) => [
    "SCARD",
    USERS_KEY_PREFIX + n,
  ]);
  const results = await pipeline(commands);
  return results.reduce((sum, r) => sum + (Number(r.result) || 0), 0);
}

async function main() {
  const startedAt = Date.now();

  let executionId = REUSE_EXEC_ID;
  if (!executionId) {
    executionId = await executeQuery(0);
    await pollUntilComplete(executionId);
  } else {
    console.log(`> Reusing execution_id: ${executionId}`);
  }

  let totalFetched = 0;
  let totalAdded = 0;
  let maxBlock = 0n;
  let offset = 0;
  let pageNum = 0;

  for (;;) {
    pageNum += 1;
    const page = await fetchPage(executionId, offset);
    const rows = page.result?.rows ?? [];

    const seen = [];
    for (const row of rows) {
      const account = String(row.account ?? "").toLowerCase();
      if (!isValidAddress(account)) continue;
      seen.push(account);
      const block = BigInt(String(row.max_block ?? "0"));
      if (block > maxBlock) maxBlock = block;
    }

    const added = await sadd(seen);
    totalFetched += seen.length;
    totalAdded += added;

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const card = await scard();
    console.log(
      `  page ${pageNum} (offset=${offset}): fetched ${seen.length}, ` +
        `+${added} new, SCARD=${card}, maxBlock=${maxBlock}, elapsed=${elapsed}s`,
    );

    const nextOffset = page.result?.metadata?.next_offset ?? page.next_offset;
    if (typeof nextOffset !== "number" || nextOffset <= offset) break;
    offset = nextOffset;
  }

  if (maxBlock > 0n) {
    await setLastBlock(maxBlock.toString());
    console.log(`> Cursor set: minipay:lastBlock = ${maxBlock}`);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const finalCard = await scard();
  console.log("");
  console.log(`✓ Done in ${elapsed}s.`);
  console.log(`  Total rows pulled: ${totalFetched}`);
  console.log(`  Total newly SADD'd: ${totalAdded}`);
  console.log(`  Final SCARD minipay:users = ${finalCard}`);
  console.log(`  minipay:lastBlock = ${maxBlock}`);
}

main().catch((err) => {
  console.error("✗ FAILED:", err.message);
  process.exit(1);
});
