#!/usr/bin/env node
/**
 * Tier 1 — bulk Arkham sweep of the distinct EXTERNAL-ACTOR addresses in the
 * indexer's data, via /intelligence/address_enriched/{addr}/all. Persists
 * into Upstash `labels` hash (source: "arkham").
 *
 * Discovery reads the indexer's PER-ADDRESS ROLLUP entities rather than raw
 * event tables: one row per address instead of one row per event, so a full
 * sweep costs ~80 Hasura pages instead of thousands. Rollups carry no chain
 * filter — Arkham keys on the address, and EVM addresses are chain-agnostic.
 * This is narrower than the production cron's DISCOVERY_TARGETS by design:
 * protocol actors (isProtocolActor), router/pool contract fields
 * (SwapEvent.recipient/.txTo, RebalanceEvent.*, Pool.rebalancerAddress), and
 * BridgeTransfer.recipient (≈ its senders) are deliberately excluded.
 * A discovery source that errors ABORTS the run before any quota is spent —
 * a partial set looks identical to full coverage afterwards; pass
 * --allow-partial-discovery to proceed anyway.
 *
 * Enrichment order (cap-aware; the trial's Intel Label quota is the binding
 * constraint, not throughput):
 *   1. existing arkham-sourced `labels` entries (refresh, on by default)
 *   2. every non-Broker-trader discovery (LPs, bridgers, borrowers, SP
 *      depositors, trove owners, OLS callers, FPMM traders, yield positions)
 *   3. Broker traders, descending by lifetime USD volume
 *
 * Write rules:
 *   - manual entries (not arkham-sourced) are never enriched and never touched
 *   - arkham-sourced entries are MERGED with the fresh result on the canonical
 *     `mergeRefreshEntry` rules from ui-dashboard/src/lib/arkham.ts: Arkham
 *     owns `name` and contributes tags, while `createdAt`, `isPublic`, and
 *     user-edited `notes` survive the refresh. Only an auto-generated
 *     "Arkham prediction (…)" note is replaced by the fresh one. A pass-1
 *     entry that a human later curated or published keeps that state.
 *   - a fresh result that fails the quality gate leaves the existing entry
 *     in place
 *   - unlabeled addresses are written as new entries
 *
 * Writes are race-safe. The `labels` snapshot is read once, but the run spans
 * 70+ minutes over ~68k addresses, so a human editing the address book
 * mid-run would otherwise be clobbered by a blind HSET. Mirroring
 * `importLabelsIfAbsent` / `importArkhamRefreshLabelsIfUnchanged` in
 * ui-dashboard/src/lib/address-labels.ts:
 *   - new addresses go in via HSETNX, so anything that appeared at that field
 *     mid-run wins
 *   - refreshes go through a compare-and-set EVAL that writes only while the
 *     stored row is still arkham-sourced AND its `updatedAt` still matches the
 *     snapshot; a user edit or a deletion beats a stale refresh
 * Both checks also enforce the manual-entry rule at the write boundary, not
 * just in the queue filter. Skips are counted and logged per category.
 *
 * Quota: every enrichment response's X-Intel-Datapoints-{Usage,Limit,Remaining}
 * headers are recorded, GET /subscription/intel-usage (free) is polled at start
 * and every 500 addresses, and the run stops cleanly once Remaining reaches
 * --quota-floor. The headers are unverified, so the intel-usage body
 * (totalLimit - totalCount) seeds the same stop logic when they never appear.
 * Two more brakes back that up: HTTP 402/403 halts immediately, and 10
 * consecutive enrichment errors trip a circuit breaker rather than grinding
 * the whole queue into failures.
 *
 * Resumes from .intel-marathon/tier1-progress-{scope}.jsonl on restart.
 *
 * Usage:
 *   node ui-dashboard/scripts/intel-marathon/tier1-bulk-enrich.mjs --dry-run
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... ARKHAM_API_KEY=... \
 *   node ui-dashboard/scripts/intel-marathon/tier1-bulk-enrich.mjs
 *
 * Flags:
 *   --dry-run          discovery + prioritization + counts only; no Arkham
 *                      calls, no Upstash writes, no files written, and no
 *                      ARKHAM_API_KEY required
 *   --limit N          cap the number of addresses enriched this run
 *   --quota-floor N    stop when Intel Label Remaining <= N (default 50)
 *   --no-refresh       skip step 1; only enrich addresses with no label
 *   --allow-partial-discovery
 *                      proceed even when a discovery source errored (the run
 *                      normally aborts to avoid spending quota on a silently
 *                      incomplete sweep)
 *   --allow-unknown-quota
 *                      start even when the startup /subscription/intel-usage
 *                      poll yielded no Remaining (the run normally refuses
 *                      rather than sweep with no quota ceiling visible)
 *   --chain <id>       output-file scope tag only (default "all"). Discovery
 *                      is cross-chain; pass this only to resume a prior
 *                      per-chain progress file.
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
const PAGE_SIZE = 1000; // Hasura row cap
const HARD_PAGE_CAP = 250; // 250k rows/source — sentinel against runaway loops
const REQ_SPACING_MS = 60; // standard bucket (100 req/s), ~16 req/s sustained
const RATE_LIMIT_BACKOFF_MS = 1500;
const HIGH_CONFIDENCE = 0.85;
const HSET_BATCH = 100;
const QUOTA_FLOOR_DEFAULT = 50;
const QUOTA_LOG_EVERY = 100; // log header-derived quota every N requests
const INTEL_USAGE_EVERY = 500; // poll /subscription/intel-usage every N addresses
const MAX_CONSECUTIVE_ERRORS = 10; // circuit breaker on a wedged/exhausted API
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const refresh = !args.includes("--no-refresh");
const allowPartialDiscovery = args.includes("--allow-partial-discovery");

function flagValue(name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const raw = args[i + 1];
  return raw === undefined || raw.startsWith("--") ? undefined : raw;
}

/**
 * Numeric flag with a hard parse failure. A typo'd `--quota-floor 5O` would
 * otherwise become NaN, and every `remaining <= NaN` comparison is false — the
 * quota brake would look configured and never fire.
 */
function numericFlag(name, fallback) {
  const raw = flagValue(name);
  if (raw === undefined) {
    // A flag typed with no value (or immediately followed by another flag,
    // e.g. `--limit --no-refresh`) must fail loudly rather than silently
    // falling back — for --limit that fallback is Infinity, which would
    // start an unbounded, quota-consuming sweep the caller didn't intend.
    if (args.includes(name)) {
      console.error(
        `Missing value for ${name} (expected a non-negative number)`,
      );
      process.exit(1);
    }
    return fallback;
  }
  // Number("") and Number("   ") are 0, so a shell-expansion accident like
  // `--limit "$UNSET_VAR"` would silently become 0 instead of erroring.
  const parsed = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`Invalid ${name}: ${raw} (expected a non-negative number)`);
    process.exit(1);
  }
  return parsed;
}

// `--chain` picks the progress/inventory filenames; silently falling back to
// "all" on a missing value would resume the wrong file.
if (args.includes("--chain") && flagValue("--chain") === undefined) {
  console.error("Missing value for --chain (expected a scope tag)");
  process.exit(1);
}
const scope = flagValue("--chain") ?? "all";
const limitArg = numericFlag("--limit", Infinity);
const quotaFloor = numericFlag("--quota-floor", QUOTA_FLOOR_DEFAULT);

// Discovery is unauthenticated Hasura, so --dry-run needs no credentials.
const required = dryRun
  ? []
  : ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "ARKHAM_API_KEY"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing env: ${missing.join(", ")}`);
  process.exit(1);
}

const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const arkhamKey = process.env.ARKHAM_API_KEY;
const hasUpstash = Boolean(redisUrl && redisToken);

// ---------------------------------------------------------------------------
// Discovery — per-address rollup entities (field names from
// indexer-envio/schema.graphql). `brokerTrader` marks the one source that is
// deprioritized to the tail of the queue; everything else shares tier 2.
// ---------------------------------------------------------------------------

const DISCOVERY_SOURCES = [
  {
    table: "TraderAllTimeAggregate",
    addressFields: ["trader"],
    volumeField: "volumeUsdWei",
    where: "{ isProtocolActor: { _eq: false } }",
  },
  {
    table: "BrokerTraderAllTimeAggregate",
    addressFields: ["caller"],
    volumeField: "volumeUsdWei",
    where: "{ isProtocolActor: { _eq: false } }",
    brokerTrader: true,
  },
  { table: "LiquidityPosition", addressFields: ["address"] },
  { table: "BorrowerInfo", addressFields: ["address"] },
  { table: "StabilityPoolDepositor", addressFields: ["address"] },
  { table: "Trove", addressFields: ["owner", "previousOwner"] },
  { table: "BridgeBridger", addressFields: ["sender"] },
  { table: "StethPosition", addressFields: ["wallet"] },
  { table: "SusdsPosition", addressFields: ["wallet"] },
  // Event tables, not rollups: page with distinct_on so one row lands per
  // address. `LiquidityEvent.sender` is deliberately absent — it holds the
  // router/pool contract, not the LP.
  {
    table: "OlsLiquidityEvent",
    addressFields: ["caller"],
    distinctOn: "caller",
  },
  {
    table: "LiquidityEvent",
    addressFields: ["recipient"],
    distinctOn: "recipient",
  },
];

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

async function pageSource(source) {
  const { table, addressFields, volumeField, where, distinctOn } = source;
  const selection = [...addressFields, ...(volumeField ? [volumeField] : [])];
  // distinct_on requires order_by to lead with the same column; plain rollup
  // pages order by the primary key so offset stepping is stable.
  const orderField = distinctOn ?? "id";
  const clauses = [
    where ? `where: ${where}` : "",
    distinctOn ? `distinct_on: [${distinctOn}]` : "",
    `order_by: { ${orderField}: asc }`,
    "limit: $limit",
    "offset: $offset",
  ].filter(Boolean);
  const query = `query Q($limit: Int!, $offset: Int!) {
      rows: ${table}(
        ${clauses.join("\n        ")}
      ) {
        ${selection.join("\n        ")}
      }
    }`;

  const out = [];
  for (let page = 0; page < HARD_PAGE_CAP; page++) {
    const data = await hasura(query, {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    });
    const rows = data.rows ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return { rows: out, capped: false };
  }
  return { rows: out, capped: true };
}

async function discoverAll() {
  console.log("→ Discovery from per-address rollups (all chains)...");
  const registry = new Map(); // address → { sources, volumeWei, nonBroker }
  const failedSources = [];
  const perSource = {}; // "Table.field" → distinct address count
  for (const source of DISCOVERY_SOURCES) {
    for (const field of source.addressFields) {
      perSource[`${source.table}.${field}`] = 0;
    }
    try {
      const { rows, capped } = await pageSource(source);
      for (const row of rows) {
        const volume = source.volumeField
          ? BigInt(row[source.volumeField] ?? "0")
          : 0n;
        for (const field of source.addressFields) {
          const address = row[field]?.toLowerCase();
          if (!isValidAddress(address) || address === ZERO_ADDRESS) continue;
          const key = `${source.table}.${field}`;
          let rec = registry.get(address);
          if (!rec) {
            rec = { sources: [], volumeWei: 0n, nonBroker: false };
            registry.set(address, rec);
          }
          if (!rec.sources.includes(key)) {
            rec.sources.push(key);
            perSource[key]++;
          }
          // Sum: TraderAllTimeAggregate is per (chainId, trader), and the same
          // address can trade on both the v3 and v2 Broker paths.
          rec.volumeWei += volume;
          if (!source.brokerTrader) rec.nonBroker = true;
        }
      }
      const counted = source.addressFields
        .map((f) => `${f}=${perSource[`${source.table}.${f}`]}`)
        .join(" ");
      console.log(
        `  ${source.table}: ${rows.length} rows → ${counted}${
          capped ? " ⚠ HARD_PAGE_CAP hit — truncated" : ""
        }`,
      );
      // A capped source is exactly as incomplete as an errored one — silently
      // sweeping a truncated registry defeats the abort-on-partial-discovery
      // guarantee this function otherwise enforces.
      if (capped) failedSources.push(source.table);
    } catch (err) {
      console.warn(`  ⚠ ${source.table}: ${err.message}`);
      failedSources.push(source.table);
      for (const field of source.addressFields) {
        perSource[`${source.table}.${field}`] = `ERROR: ${err.message}`;
      }
    }
  }
  // A failed source silently shrinks the sweep — quota spent against an
  // incomplete discovery set looks identical to full coverage afterwards.
  // Abort instead, unless the caller explicitly accepted the gap.
  if (failedSources.length > 0 && !allowPartialDiscovery) {
    console.error(
      `✗ Discovery incomplete — ${failedSources.length} source(s) failed: ` +
        `${failedSources.join(", ")}. Re-run, or pass ` +
        `--allow-partial-discovery to enrich the partial set anyway.`,
    );
    process.exit(1);
  }
  console.log(`→ Discovery total (deduped): ${registry.size} addresses`);
  return { registry, perSource };
}

// ---------------------------------------------------------------------------
// Upstash + candidate prioritization
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
  // HGETALL of the entire `labels` hash — the manual/arkham split below is
  // decided from it.
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

/**
 * Compare-and-set refresh, adapted from
 * HSET_ARKHAM_REFRESH_IF_UNCHANGED_SCRIPT in
 * ui-dashboard/src/lib/address-labels.ts. ARGV is (field, expectedUpdatedAt,
 * value) triples. Writes only while the stored row is still arkham-sourced and
 * its `updatedAt` still matches what this run read at start; a row edited,
 * re-sourced, or deleted mid-run is left alone.
 *
 * Returns the list of SKIPPED fields rather than the lib's written count, so
 * the caller can attribute each skip to its address in the progress file.
 */
const REFRESH_IF_UNCHANGED_SCRIPT = `
local skipped = {}
for i = 1, #ARGV, 3 do
  local field = ARGV[i]
  local expected_updated_at = ARGV[i + 1]
  local value = ARGV[i + 2]
  local write_ok = false
  local current = redis.call("HGET", KEYS[1], field)
  if current ~= false then
    local ok, parsed = pcall(cjson.decode, current)
    if ok and type(parsed) == "table" then
      local is_arkham = parsed["source"] == "arkham"
      local tags = parsed["tags"]
      if not is_arkham and type(tags) == "table" then
        for _, tag in ipairs(tags) do
          if tag == "arkham" then
            is_arkham = true
            break
          end
        end
      end
      local raw_updated_at = parsed["updatedAt"]
      local current_updated_at = type(raw_updated_at) == "string" and raw_updated_at or ""
      if is_arkham and current_updated_at == expected_updated_at then
        write_ok = true
      end
    end
  end
  if write_ok then
    redis.call("HSET", KEYS[1], field, value)
  else
    skipped[#skipped + 1] = field
  end
end
return skipped
`;

const ARKHAM_TAG = "arkham";

// Mirrors isArkhamSourced() in ui-dashboard/src/lib/address-labels-shared.ts:
// new entries carry `source: "arkham"`, pre-source-field entries carry the
// exact `"arkham"` tag sentinel. Non-exact display tags stay manual.
function isArkhamSourced(entry) {
  if (!entry || typeof entry !== "object") return false;
  return entry.source === "arkham" || entry.tags?.includes(ARKHAM_TAG) === true;
}

/**
 * Order the work: arkham-sourced refreshes first, then everything discovered
 * outside the Broker trader rollup, then Broker traders by lifetime USD volume
 * descending. Manually-labeled addresses drop out entirely.
 */
function buildQueue(registry, existing) {
  const queue = [];
  const seen = new Set();
  let manualSkipped = 0;
  let labeledSkipped = 0;

  if (refresh) {
    const refreshTier = Object.entries(existing)
      .filter(
        ([address, entry]) => isValidAddress(address) && isArkhamSourced(entry),
      )
      .map(([address]) => address)
      .sort();
    for (const address of refreshTier) {
      const rec = registry.get(address);
      queue.push({
        address,
        tier: "refresh",
        sources: rec?.sources ?? ["labels:arkham"],
        volumeWei: rec?.volumeWei ?? 0n,
      });
      seen.add(address);
    }
  }

  const discovery = [];
  const brokerTraders = [];
  for (const [address, rec] of registry) {
    if (seen.has(address)) continue;
    const current = existing[address];
    if (current) {
      if (isArkhamSourced(current)) labeledSkipped++;
      else manualSkipped++;
      continue;
    }
    const item = {
      address,
      tier: rec.nonBroker ? "discovery" : "broker-trader",
      sources: rec.sources,
      volumeWei: rec.volumeWei,
    };
    (rec.nonBroker ? discovery : brokerTraders).push(item);
  }

  // Volume desc, address asc as the tie-break so the order is reproducible
  // across runs (needed for resume to line up with the prior run's progress).
  const byVolume = (a, b) => {
    if (a.volumeWei !== b.volumeWei) return a.volumeWei > b.volumeWei ? -1 : 1;
    return a.address < b.address ? -1 : 1;
  };
  discovery.sort(byVolume);
  brokerTraders.sort(byVolume);

  queue.push(...discovery, ...brokerTraders);
  return {
    queue,
    tiers: {
      refresh: queue.length - discovery.length - brokerTraders.length,
      discovery: discovery.length,
      brokerTrader: brokerTraders.length,
    },
    manualSkipped,
    labeledSkipped,
  };
}

// ---------------------------------------------------------------------------
// Arkham — fetch + quota accounting + map to AddressEntry.
// ---------------------------------------------------------------------------

// Trial plan: 10,000 unique labeled-address lookups per billing period
// ("Intel Label Limit"). Observed rather than assumed — unlabeled 404s appear
// not to consume quota, but the numbers come from the API either way.
//
// Two sources, in precedence order. Response headers are authoritative and
// per-request, so once they have been seen they own the values. The
// /subscription/intel-usage body is the fallback: the headers are unverified,
// and without a fallback a header-less API would leave `remaining` null and the
// --quota-floor stop would never fire.
//
// Precedence is tracked per-field for `remaining`, not for the header set as a
// whole: an API that sends Usage/Limit but no Remaining must not switch off the
// body fallback, or `remaining` would stay null and the stop would never fire.
const quota = {
  usage: null,
  limit: null,
  remaining: null,
  seen: false, // any source has reported numbers
  fromHeaders: false, // response headers have reported numbers at least once
  remainingFromHeaders: false, // a header has reported Remaining specifically
};

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

function headerNumber(res, name) {
  const raw = res.headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Records the quota headers; returns true when Remaining dropped. */
function noteQuotaHeaders(res) {
  const usage = headerNumber(res, "X-Intel-Datapoints-Usage");
  const limit = headerNumber(res, "X-Intel-Datapoints-Limit");
  const remaining = headerNumber(res, "X-Intel-Datapoints-Remaining");
  if (usage === null && limit === null && remaining === null) return false;
  const dropped =
    quota.remaining !== null &&
    remaining !== null &&
    remaining < quota.remaining;
  if (usage !== null) quota.usage = usage;
  if (limit !== null) quota.limit = limit;
  if (remaining !== null) {
    quota.remaining = remaining;
    quota.remainingFromHeaders = true;
  }
  quota.seen = true;
  quota.fromHeaders = true;
  return dropped;
}

function quotaLine() {
  if (!quota.seen) return "quota not yet observed";
  return `usage=${quota.usage ?? "?"} limit=${quota.limit ?? "?"} remaining=${
    quota.remaining ?? "?"
  } via=${quota.remainingFromHeaders ? "headers" : "intel-usage"}`;
}

// Live body shape (probed 2026-08-24):
//   { totalCount, totalLimit, chainUsage: {...}, periodStart }
// Derive remaining from that pair; the "*remaining*" key scan is the secondary
// path in case the shape changes.
function remainingFromUsageBody(body) {
  if (!body || typeof body !== "object") return null;
  if (isFiniteNumber(body.totalLimit) && isFiniteNumber(body.totalCount)) {
    return body.totalLimit - body.totalCount;
  }
  for (const [key, value] of Object.entries(body)) {
    if (/remaining/i.test(key) && isFiniteNumber(value)) return value;
  }
  return null;
}

/** Free endpoint — does not consume Intel Label quota. */
async function logIntelUsage(context) {
  try {
    const res = await fetch(`${ARKHAM_BASE}/subscription/intel-usage`, {
      headers: { "API-Key": arkhamKey },
      signal: AbortSignal.timeout(15_000),
    });
    noteQuotaHeaders(res);
    if (!res.ok) {
      console.warn(`  ⚠ intel-usage (${context}): HTTP ${res.status}`);
      return;
    }
    const body = await res.json();
    // A Remaining header wins once seen. Until then every poll refreshes the
    // body-derived numbers, so the --quota-floor stop stays live on an API that
    // sends no Remaining header at all — or only Usage/Limit.
    if (!quota.remainingFromHeaders) {
      const remaining = remainingFromUsageBody(body);
      if (remaining !== null) {
        quota.remaining = remaining;
        quota.seen = true;
      }
      if (isFiniteNumber(body.totalCount)) quota.usage = body.totalCount;
      if (isFiniteNumber(body.totalLimit)) quota.limit = body.totalLimit;
    }
    console.log(`  intel-usage (${context}): ${JSON.stringify(body)}`);
  } catch (err) {
    console.warn(`  ⚠ intel-usage (${context}) failed: ${err.message}`);
  }
}

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
  const dropped = noteQuotaHeaders(res);
  if (res.status === 404) return { status: 404, data: null, dropped };
  if (res.status === 401) throw new Error("ARKHAM_AUTH_FAIL");
  // 402 Payment Required / 403 Forbidden — the plan is refusing the call, so
  // the rest of the queue would refuse too. Halt rather than burn it.
  if (res.status === 402 || res.status === 403)
    throw new Error("ARKHAM_ENTITLEMENT");
  if (res.status === 429) throw new Error("ARKHAM_RATE_LIMITED");
  if (!res.ok) throw new Error(`arkham_http_${res.status}`);
  return { status: 200, data: await res.json(), dropped };
}

// Mirrors arkham.ts toAddressEntry().
function toAddressEntry(data) {
  let label, entity, topPred;
  const tagSet = new Set();
  for (const perChain of Object.values(data)) {
    const trimmed = perChain.arkhamLabel?.name?.trim();
    if (!label && trimmed) label = trimmed;
    if (!entity && perChain.arkhamEntity?.name?.trim())
      entity = perChain.arkhamEntity;
    if (entity?.type) tagSet.add(entity.type);
    // `populatedTags[].id` is the current field; `tags[].slug` is the one it
    // replaced in 2026-08. Union both so either shape yields tags.
    for (const t of perChain.populatedTags ?? []) if (t.id) tagSet.add(t.id);
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
  // sanitizeEntry(), as the lib's toAddressEntry does — a NEW entry gets the
  // same trim / case-insensitive tag dedup / length caps the dashboard's own
  // writes get, not just the merged refresh path below.
  return sanitizeEntry({
    name,
    tags: Array.from(tagSet),
    notes: note,
    isPublic: false,
    source: "arkham",
    updatedAt: new Date().toISOString(),
  });
}

// Entry-shape limits, mirroring ui-dashboard/src/lib/address-labels-shared.ts.
const MAX_NAME_LENGTH = 200;
const MAX_NOTES_LENGTH = 500;
const MAX_TAGS_COUNT = 20;
const MAX_TAG_LENGTH = 50;
const AUTO_NOTE_PREFIX = "Arkham prediction (";

// Mirrors sanitizeEntry(): truncate name/notes, cap tag count and length,
// trim and case-insensitively dedup tags. Needed after a merge because the
// union of fresh + existing tags can exceed the cap.
function sanitizeEntry(entry) {
  const seenTags = new Set();
  // Dedupe/drop-blank BEFORE capping — otherwise a blank or duplicate tag
  // early in the list consumes a slot in the 20-item cap that a later,
  // genuinely unique tag never gets to fill.
  const tags = entry.tags
    .flatMap((raw) => {
      const t = String(raw).trim().slice(0, MAX_TAG_LENGTH);
      if (!t) return [];
      const key = t.toLowerCase();
      if (seenTags.has(key)) return [];
      seenTags.add(key);
      return [t];
    })
    .slice(0, MAX_TAGS_COUNT);
  const notes = entry.notes?.slice(0, MAX_NOTES_LENGTH);
  return {
    ...entry,
    name: entry.name.trim().slice(0, MAX_NAME_LENGTH),
    tags,
    ...(notes !== undefined ? { notes } : {}),
  };
}

// Mirrors withoutArkhamTags(): the legacy provenance sentinel never survives
// into a merged tag set — provenance lives in `source`.
function withoutArkhamTags(tags) {
  return tags.filter((tag) => String(tag).trim().toLowerCase() !== ARKHAM_TAG);
}

/**
 * Merge a fresh Arkham result into the existing entry, mirroring
 * `mergeRefreshEntry` in ui-dashboard/src/lib/arkham.ts exactly.
 *
 * Arkham owns `name` and contributes tags; `createdAt`, `isPublic`, and
 * user-edited `notes` survive the refresh. A pass-1 entry that a human later
 * curated or published in the address-book UI keeps that state — an overwrite
 * would silently un-publish it, since fresh entries always carry
 * `isPublic: false`. Only our own auto-generated "Arkham prediction (…)" note
 * is replaced by the fresh one.
 *
 * A null fresh entry (quality gate failed) never reaches here, so the existing
 * entry survives untouched. Manual entries never reach here either — buildQueue
 * drops them — which is why the non-arkham branch just returns `fresh`, as the
 * lib does.
 */
function buildWriteEntry(fresh, current) {
  if (!current || !isArkhamSourced(current)) {
    return { ...fresh, createdAt: current?.createdAt ?? fresh.updatedAt };
  }
  const isAutoNote = current.notes?.startsWith(AUTO_NOTE_PREFIX) === true;
  // Existing tags first: `current.tags` can carry Tier 2's forensic ctp:/type:
  // tags (curated, one-shot) ahead of a bulk Arkham tag dump. Now that
  // populatedTags can fill the 20-tag cap on its own, putting `fresh` first
  // would let a routine refresh silently evict that curated content.
  const tags = withoutArkhamTags(
    Array.from(new Set([...(current.tags ?? []), ...fresh.tags])),
  );
  return sanitizeEntry({
    name: fresh.name,
    tags,
    notes: isAutoNote ? fresh.notes : (current.notes ?? fresh.notes),
    isPublic: current.isPublic ?? fresh.isPublic,
    source: "arkham",
    createdAt: current.createdAt ?? fresh.updatedAt,
    updatedAt: fresh.updatedAt,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printPlan(perSource, registry, plan) {
  console.log("");
  console.log("→ Per-source distinct addresses:");
  for (const [key, count] of Object.entries(perSource)) {
    console.log(`  ${key}: ${count}`);
  }
  console.log(`  TOTAL deduped: ${registry.size}`);
  console.log("");
  console.log("→ Enrichment plan:");
  console.log(`  1. refresh (arkham-sourced labels): ${plan.tiers.refresh}`);
  console.log(`  2. discovery (non-Broker-trader):   ${plan.tiers.discovery}`);
  console.log(
    `  3. Broker traders by volume:        ${plan.tiers.brokerTrader}`,
  );
  console.log(`  skipped, manual label:              ${plan.manualSkipped}`);
  console.log(`  skipped, already arkham-labeled:    ${plan.labeledSkipped}`);
  console.log(`  QUEUE TOTAL:                        ${plan.queue.length}`);
}

async function main() {
  const startedAt = Date.now();
  const { registry, perSource } = await discoverAll();

  // Dry runs still read labels when Upstash creds happen to be present, so the
  // tier sizes are real rather than "everything is new".
  let existing = {};
  if (hasUpstash) {
    console.log("→ Loading existing labels from Upstash...");
    existing = await getLabels();
    console.log(
      `  ${Object.keys(existing).length} entries currently in labels`,
    );
  } else if (dryRun) {
    console.log("→ No Upstash credentials — tier 1 (refresh) reported as 0.");
  }

  const plan = buildQueue(registry, existing);

  if (dryRun) {
    printPlan(perSource, registry, plan);
    const top = plan.queue
      .filter((c) => c.tier === "broker-trader")
      .slice(0, 10);
    if (top.length > 0) {
      console.log("");
      console.log("→ Top Broker traders by lifetime USD volume (wei):");
      for (const c of top) console.log(`  ${c.address} ${c.volumeWei}`);
    }
    console.log("");
    console.log("✓ Dry run — no Arkham calls, no writes.");
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const rawFile = `${OUT_DIR}/tier1-raw-${scope}.jsonl`;
  const progressFile = `${OUT_DIR}/tier1-progress-${scope}.jsonl`;

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

  writeFileSync(
    `${OUT_DIR}/tier1-inventory-${scope}.json`,
    JSON.stringify(
      {
        scope,
        refresh,
        perSource,
        totalDeduped: registry.size,
        tiers: plan.tiers,
        manualSkipped: plan.manualSkipped,
        labeledSkipped: plan.labeledSkipped,
        queueTotal: plan.queue.length,
      },
      null,
      2,
    ),
  );
  // Per-address provenance, in queue order — what surfaced each address and
  // the lifetime USD volume that ranked it.
  writeFileSync(
    `${OUT_DIR}/tier1-plan-${scope}.jsonl`,
    plan.queue
      .map((c) =>
        JSON.stringify({
          address: c.address,
          tier: c.tier,
          sources: c.sources,
          volumeUsdWei: String(c.volumeWei),
        }),
      )
      .join("\n") + "\n",
  );
  printPlan(perSource, registry, plan);

  let candidates = plan.queue.filter((c) => !processed.has(c.address));
  if (candidates.length > limitArg) candidates = candidates.slice(0, limitArg);
  console.log("");
  console.log(`→ ${candidates.length} addresses to enrich this run`);

  await logIntelUsage("start");
  // Fail closed on unknown quota. If the startup poll yielded nothing (timeout,
  // non-2xx, unrecognized body) and no header has reported Remaining, the floor
  // check would compare against null forever and the sweep would run unbounded.
  // Headers only start arriving with the first enrichment response, so this is
  // the last safe moment to refuse.
  if (quota.remaining === null && !args.includes("--allow-unknown-quota")) {
    console.error(
      "✗ Quota unknown: /subscription/intel-usage yielded no Remaining. " +
        "Refusing to start an unbounded sweep — retry, or pass " +
        "--allow-unknown-quota to proceed on header-based accounting alone.",
    );
    process.exit(1);
  }

  let attested = 0;
  let written = 0;
  let newSkippedExists = 0;
  let refreshSkippedChanged = 0;
  let nullCount = 0;
  let errorCount = 0;
  let stoppedForQuota = false;
  let consecutiveErrors = 0;
  const pendingWrites = [];

  function noteSkip(address, reason) {
    appendFileSync(
      progressFile,
      JSON.stringify({ address, write: reason }) + "\n",
    );
  }

  /** HSETNX batch — anything that appeared at the field mid-run wins. */
  async function flushNewWrites(batch) {
    const results = await pipeline(
      batch.map((w) => [
        "HSETNX",
        "labels",
        w.address,
        JSON.stringify(w.entry),
      ]),
    );
    for (let i = 0; i < batch.length; i++) {
      if (Number(results[i]?.result) === 1) {
        written++;
        appendFileSync(
          progressFile,
          JSON.stringify({ address: batch[i].address, write: "written" }) +
            "\n",
        );
        continue;
      }
      newSkippedExists++;
      noteSkip(batch[i].address, "skipped_exists");
    }
  }

  /** Compare-and-set batch — a row edited or deleted mid-run wins. */
  async function flushRefreshWrites(batch) {
    const argv = batch.flatMap((w) => [
      w.address,
      w.expectedUpdatedAt,
      JSON.stringify(w.entry),
    ]);
    const [response] = await pipeline([
      ["EVAL", REFRESH_IF_UNCHANGED_SCRIPT, "1", "labels", ...argv],
    ]);
    const skipped = new Set(response?.result ?? []);
    for (const w of batch) {
      if (!skipped.has(w.address)) {
        written++;
        appendFileSync(
          progressFile,
          JSON.stringify({ address: w.address, write: "written" }) + "\n",
        );
        continue;
      }
      refreshSkippedChanged++;
      noteSkip(w.address, "skipped_changed");
    }
  }

  async function flushWrites() {
    if (pendingWrites.length === 0) return;
    const batch = pendingWrites.splice(0, pendingWrites.length);
    const news = batch.filter((w) => w.mode === "new");
    const refreshes = batch.filter((w) => w.mode === "refresh");
    try {
      if (news.length > 0) await flushNewWrites(news);
      if (refreshes.length > 0) await flushRefreshWrites(refreshes);
    } catch (err) {
      // Put the batch back (protects an in-process retry, e.g. a later
      // threshold flush succeeding after a transient blip) and re-throw so
      // the caller halts rather than silently grinding through the queue.
      // recordResult() deliberately never wrote a progressFile line for
      // these addresses, so if the process halts here instead of retrying,
      // a resumed run re-fetches and re-attempts them rather than skipping
      // addresses whose write never landed.
      pendingWrites.unshift(...batch);
      throw err;
    }
  }

  /** Halt on errors that every remaining address would hit too. */
  async function haltIfFatal(message) {
    if (message === "ARKHAM_AUTH_FAIL") {
      console.error("✗ Arkham key rejected. Halting.");
      await flushWrites();
      process.exit(2);
    }
    if (message === "ARKHAM_ENTITLEMENT") {
      console.error(
        "✗ Arkham returned 402/403 — plan entitlement or Intel Label quota exhausted. Halting.",
      );
      console.error(`  quota: ${quotaLine()}`);
      console.error(
        `  Re-run once the quota resets; ${progressFile} resumes the queue.`,
      );
      await flushWrites();
      process.exit(2);
    }
  }

  /**
   * Count one failure and trip the circuit breaker at the limit. Without this
   * an API that starts refusing every call (quota exhaustion behind a status
   * code we don't special-case, or an outage) would grind the whole queue into
   * errors before anyone noticed.
   */
  async function noteFailure(message) {
    errorCount++;
    consecutiveErrors++;
    if (consecutiveErrors < MAX_CONSECUTIVE_ERRORS) return;
    await flushWrites();
    console.error("");
    console.error(
      `✗ ${MAX_CONSECUTIVE_ERRORS} consecutive Arkham errors — halting.`,
    );
    console.error(`  last error: ${message}`);
    console.error(`  quota: ${quotaLine()}`);
    console.error(
      `  Check GET /subscription/intel-usage; ${progressFile} resumes the queue.`,
    );
    process.exit(3);
  }

  function recordResult(address, status, data) {
    // The call itself succeeded (200 or a clean 404), so the API is answering.
    consecutiveErrors = 0;
    if (status !== 200 || !data) {
      nullCount++;
      appendFileSync(progressFile, JSON.stringify({ address, status }) + "\n");
      return;
    }
    // Body-sourced `remaining` only refreshes via the periodic
    // /subscription/intel-usage poll below, so it can otherwise sit stale for
    // up to INTEL_USAGE_EVERY requests while the floor check keeps comparing
    // against it. Decrement it locally on every 200-with-data lookup — each
    // one consumed an Intel Label datapoint on Arkham's side regardless of
    // our own quality gate — so the floor check stays live between polls.
    // Gate on remainingFromHeaders, NOT fromHeaders: a response that carries
    // Usage/Limit but omits Remaining still leaves `remaining` body-sourced,
    // and must keep this decrement active. Once a header reports Remaining,
    // noteQuotaHeaders() takes over per-request and this is a no-op.
    if (!quota.remainingFromHeaders && quota.remaining !== null) {
      quota.remaining -= 1;
    }
    const entry = toAddressEntry(data);
    if (!entry) {
      // Quality gate failed. On a refresh this deliberately leaves the prior
      // entry in place rather than deleting it.
      nullCount++;
      appendFileSync(progressFile, JSON.stringify({ address, status }) + "\n");
      return;
    }
    // The start snapshot decides the write mode. Absent then → HSETNX now;
    // present then → compare-and-set against the `updatedAt` we read.
    // Progress for this address is recorded once the write is durably
    // confirmed (flushNewWrites/flushRefreshWrites/noteSkip), not here —
    // recording it now would let a resumed run skip an address whose label
    // write never actually landed (e.g. the process halts on a flush
    // failure before this batch is retried).
    const current = existing[address];
    pendingWrites.push({
      address,
      entry: buildWriteEntry(entry, current),
      mode: current ? "refresh" : "new",
      expectedUpdatedAt:
        typeof current?.updatedAt === "string" ? current.updatedAt : "",
    });
    attested++;
  }

  for (let i = 0; i < candidates.length; i++) {
    const address = candidates[i].address;
    if (quota.remaining !== null && quota.remaining <= quotaFloor) {
      stoppedForQuota = true;
      break;
    }
    try {
      const { status, data, dropped } = await fetchEnriched(address);
      appendFileSync(
        rawFile,
        JSON.stringify({ address, status, data, ts: Date.now() }) + "\n",
      );
      // recordResult() records progress itself, once the outcome (no write
      // needed, or the write's durable result) is actually known.
      recordResult(address, status, data);
      if (dropped) console.log(`  quota ↓ after ${address}: ${quotaLine()}`);
    } catch (err) {
      await haltIfFatal(err.message);
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
          recordResult(address, status, data);
        } catch (retryErr) {
          // A key rotated or a plan exhausted mid-batch is still fatal here.
          await haltIfFatal(retryErr.message);
          appendFileSync(
            progressFile,
            JSON.stringify({ address, error: retryErr.message }) + "\n",
          );
          await noteFailure(retryErr.message);
        }
      } else {
        appendFileSync(
          progressFile,
          JSON.stringify({ address, error: err.message }) + "\n",
        );
        await noteFailure(err.message);
      }
    }
    // Outside the Arkham try/catch above: a storage failure here is not an
    // Arkham enrichment error and must not be absorbed by noteFailure() (which
    // would reset consecutiveErrors on the next successful fetch and mask a
    // sustained Upstash outage from the circuit breaker). Let it propagate to
    // main().catch() and halt the run instead of grinding through the whole
    // queue while silently writing nothing.
    if (pendingWrites.length >= HSET_BATCH) await flushWrites();
    const done = i + 1;
    if (done % QUOTA_LOG_EVERY === 0) {
      await flushWrites();
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `  [${done}/${candidates.length}] attested=${attested} written=${written} skipExists=${newSkippedExists} skipChanged=${refreshSkippedChanged} null=${nullCount} errors=${errorCount} elapsed=${elapsed}s ${quotaLine()}`,
      );
    }
    // Tighten the poll cadence near the floor while quota is body-sourced —
    // the local per-address decrement above is a best-effort estimate (an
    // unlabeled 404 may not consume a datapoint the same way), so refresh
    // against the authoritative body more often once the estimate is close
    // enough to the floor that a 500-request gap between real polls risks
    // overshooting it.
    const intelUsageEvery =
      !quota.remainingFromHeaders &&
      quota.remaining !== null &&
      quota.remaining - quotaFloor < 500
        ? 100
        : INTEL_USAGE_EVERY;
    if (done % intelUsageEvery === 0) await logIntelUsage(`after ${done}`);
    if (i < candidates.length - 1) await sleep(REQ_SPACING_MS);
  }

  await flushWrites();
  await logIntelUsage("end");
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("");
  if (stoppedForQuota) {
    console.log(
      `⚠ Stopped early: Intel Label remaining hit the --quota-floor of ${quotaFloor}.`,
    );
    console.log(`  Re-run after the quota resets; ${progressFile} resumes it.`);
  }
  console.log(`✓ Tier 1 scope=${scope} done in ${elapsed}s.`);
  console.log(`  queued:        ${candidates.length}`);
  console.log(`  attested:      ${attested}   (passed the quality gate)`);
  console.log(`  written:       ${written}`);
  console.log(`  skipped, field appeared mid-run: ${newSkippedExists}`);
  console.log(`  skipped, entry changed mid-run:  ${refreshSkippedChanged}`);
  console.log(`  null:          ${nullCount}`);
  console.log(`  errors:        ${errorCount}`);
  console.log(`  quota:         ${quotaLine()}`);
  console.log(`  raw:           ${rawFile}`);
}

main().catch((err) => {
  console.error("✗ FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
