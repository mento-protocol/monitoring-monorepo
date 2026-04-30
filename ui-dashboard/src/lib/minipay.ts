/**
 * MiniPay user tagging — Dune client + Redis SET helpers.
 *
 * Source data: Celo `FederatedAttestations` events filtered to the MiniPay
 * issuer (`0x7888612486844bb9be598668081c59a9f7367fbc`). Dune query 7404332
 * exposes them as `(account, max_block)` rows with a `lastBlock` parameter
 * for incremental sync.
 *
 * The user set lives in Upstash Redis as a SET (`minipay:users`); the last
 * synced block is a STRING (`minipay:lastBlock`). Tagging consumers use
 * `intersectMiniPay` to test Mento addresses against the SET.
 *
 * NEVER import from a client component. DUNE_API_KEY is server-only.
 */

import { Redis } from "@upstash/redis";
import {
  MINIPAY_SOURCE,
  sanitizeEntry,
  type AddressEntry,
} from "@/lib/address-labels-shared";
import { isValidAddress } from "@/lib/validators";

const DUNE_BASE = "https://api.dune.com";
const DUNE_QUERY_ID = 7404332;

// Dune execution polling — first-run cold-cache (full FederatedAttestation
// history scan) can take several minutes; incremental runs are typically a
// few seconds. 600s budget leaves ~200s of the 800s maxDuration for results
// pagination + chunked SADD into Upstash.
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_ATTEMPTS = 120;

// Per-request timeout. POLL_MAX_ATTEMPTS only bounds successful poll iterations;
// a single fetch wedged at TLS/socket level needs an explicit AbortSignal or
// the cron just sits until Vercel kills the invocation. Mirrors the pattern
// used by `arkham-discovery.ts` for Hasura calls.
const REQUEST_TIMEOUT_MS = 30_000;

// Upstash command-size cap is 1 MB; a SADD of 1000 lowercase 0x-addresses
// (~42 B each) is comfortably under that.
const SADD_CHUNK = 1000;
const SMISMEMBER_CHUNK = 1000;

// Upstash imposes a per-record 100 MB cap (Pay-as-you-go tier). The full
// MiniPay attestation set is ~16M addresses ≈ 1 GB worth of SET bytes, so
// a single `minipay:users` SET hits the limit at ~1.7M members. Shard over
// the first nibble of the lowercased address (`0x[0-9a-f]…`) — addresses
// are EOA-derived randomness so the 16 buckets stay near-uniform (~1M each
// at full ingest, well under 100 MB). Bumping to 256 shards (2 nibbles)
// would take ~63k each but adds round-trip overhead with no real benefit
// at our cardinality.
const SHARD_NIBBLES = "0123456789abcdef";
const USERS_KEY_PREFIX = "minipay:users:";
function shardKey(address: string): string {
  // Address is `0x` + 40 hex chars; the first hex char (idx 2) is the shard.
  return USERS_KEY_PREFIX + address[2];
}
function allShardKeys(): string[] {
  return SHARD_NIBBLES.split("").map((n) => USERS_KEY_PREFIX + n);
}
const LAST_BLOCK_KEY = "minipay:lastBlock";

// Redis client — same lazy-init pattern as `address-labels.ts:46-55`.
function getRedis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Upstash Redis not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
    );
  }
  return new Redis({ url, token });
}

// ── Dune API ─────────────────────────────────────────────────────────────────

export class DuneAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuneAuthError";
  }
}

export class DuneExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuneExecutionError";
  }
}

type DuneExecuteResponse = {
  execution_id: string;
  state: string;
};

type DuneStatusResponse = {
  execution_id: string;
  state:
    | "QUERY_STATE_PENDING"
    | "QUERY_STATE_EXECUTING"
    | "QUERY_STATE_COMPLETED"
    | "QUERY_STATE_FAILED"
    | "QUERY_STATE_CANCELLED"
    | "QUERY_STATE_EXPIRED";
};

type DuneResultsResponse = {
  execution_id: string;
  state: string;
  result?: {
    rows: Array<Record<string, unknown>>;
    metadata?: {
      next_offset?: number;
    };
  };
  next_offset?: number;
};

async function duneFetch(
  path: string,
  apiKey: string,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(`${DUNE_BASE}${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      "X-Dune-API-Key": apiKey,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new DuneAuthError(`Dune API rejected the key (${res.status})`);
  }
  return res;
}

async function executeQuery(
  apiKey: string,
  lastBlock: bigint,
): Promise<string> {
  const res = await duneFetch(
    `/api/v1/query/${DUNE_QUERY_ID}/execute`,
    apiKey,
    {
      method: "POST",
      body: JSON.stringify({
        query_parameters: {
          // Dune Number-typed parameters are sent as strings on the wire.
          lastBlock: lastBlock.toString(),
        },
      }),
    },
  );
  if (!res.ok) {
    throw new DuneExecutionError(
      `execute failed: ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  const body = (await res.json()) as DuneExecuteResponse;
  return body.execution_id;
}

async function pollUntilComplete(
  apiKey: string,
  executionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
    const res = await duneFetch(
      `/api/v1/execution/${executionId}/status`,
      apiKey,
    );
    if (!res.ok) {
      throw new DuneExecutionError(
        `status failed: ${res.status} ${await res.text().catch(() => "")}`,
      );
    }
    const body = (await res.json()) as DuneStatusResponse;
    if (body.state === "QUERY_STATE_COMPLETED") return;
    if (
      body.state === "QUERY_STATE_FAILED" ||
      body.state === "QUERY_STATE_CANCELLED" ||
      body.state === "QUERY_STATE_EXPIRED"
    ) {
      throw new DuneExecutionError(`execution ended in state ${body.state}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new DuneExecutionError(
    `execution did not complete within ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS}ms`,
  );
}

// Dune's `/execution/{id}/results` paginates by `limit` + `offset`. Without
// an explicit `limit`, large result sets return a 4xx. The API caps at
// 32k/page; 10k is a comfortable middle ground that cuts round-trips by 10×
// vs. the previous 1k while staying well below memory or response-size
// limits (10k addresses × ~50 B ≈ 500 KB JSON).
const DUNE_RESULTS_LIMIT = 10_000;

async function fetchResultsPage(
  apiKey: string,
  executionId: string,
  offset: number,
): Promise<DuneResultsResponse> {
  const params = new URLSearchParams({
    limit: String(DUNE_RESULTS_LIMIT),
    ...(offset > 0 ? { offset: String(offset) } : {}),
  });
  const res = await duneFetch(
    `/api/v1/execution/${executionId}/results?${params.toString()}`,
    apiKey,
  );
  if (!res.ok) {
    throw new DuneExecutionError(
      `results failed: ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  return (await res.json()) as DuneResultsResponse;
}

export type FetchPage = {
  addresses: string[];
  /** Highest `max_block` seen on this page (not cumulative). */
  maxBlock: bigint;
};

/**
 * Stream MiniPay attestation rows from Dune one page at a time. Yields each
 * page's deduped lowercase addresses + per-page max block; the caller is
 * responsible for SADD'ing each page and tracking the cumulative maxBlock.
 *
 * Per-page yielding means the first-run backfill (millions of rows) doesn't
 * accumulate the entire result set in heap, and any cross-page failure
 * leaves prior pages persisted in Redis (SADD is idempotent on retry).
 *
 * Cross-page dedup is unnecessary by query construction: the Dune query
 * groups by account, so each address appears in exactly one row across the
 * full result set.
 */
export async function* fetchMiniPayUsers(opts: {
  apiKey: string;
  lastBlock: bigint;
}): AsyncGenerator<FetchPage> {
  const executionId = await executeQuery(opts.apiKey, opts.lastBlock);
  await pollUntilComplete(opts.apiKey, executionId);

  let offset = 0;
  for (;;) {
    const page = await fetchResultsPage(opts.apiKey, executionId, offset);
    const rows = page.result?.rows ?? [];
    const seen = new Set<string>();
    let maxBlock = BigInt(0);
    for (const row of rows) {
      const account = String(row.account ?? "").toLowerCase();
      if (!isValidAddress(account)) continue;
      seen.add(account);
      const block = BigInt(String(row.max_block ?? "0"));
      if (block > maxBlock) maxBlock = block;
    }
    if (seen.size > 0) {
      yield { addresses: Array.from(seen), maxBlock };
    }
    const nextOffset = page.result?.metadata?.next_offset ?? page.next_offset;
    if (typeof nextOffset !== "number" || nextOffset <= offset) break;
    offset = nextOffset;
  }
}

// ── Redis SET helpers ────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Group addresses by shard key (first hex nibble after `0x`). */
function bucketByShard(addresses: string[]): Map<string, string[]> {
  const buckets = new Map<string, string[]>();
  for (const a of addresses) {
    const k = shardKey(a);
    let list = buckets.get(k);
    if (!list) {
      list = [];
      buckets.set(k, list);
    }
    list.push(a);
  }
  return buckets;
}

/** SADD addresses to the sharded MiniPay set. Returns the cumulative number
 *  of *newly added* members (sum of SADD return values across all shards). */
export async function addToMiniPaySet(addresses: string[]): Promise<number> {
  if (addresses.length === 0) return 0;
  const redis = getRedis();
  let added = 0;
  for (const [key, members] of bucketByShard(addresses)) {
    for (const batch of chunk(members, SADD_CHUNK)) {
      // SADD signature requires `(key, member, ...members)` — split the chunk
      // so the first member is positional. Chunks are guaranteed non-empty.
      const [head, ...tail] = batch;
      added += await redis.sadd(key, head!, ...tail);
    }
  }
  return added;
}

/** Cumulative SCARD across all shards. */
export async function getMiniPaySetSize(): Promise<number> {
  const redis = getRedis();
  const sizes = await Promise.all(allShardKeys().map((k) => redis.scard(k)));
  return sizes.reduce((a, b) => a + b, 0);
}

/**
 * Return the subset of `addresses` that are members of the MiniPay set.
 * Bucketed by shard so each SMISMEMBER hits exactly one shard's bytes;
 * shards are queried in parallel (chunks within a shard stay sequential
 * because they share state).
 */
export async function intersectMiniPay(addresses: string[]): Promise<string[]> {
  if (addresses.length === 0) return [];
  const redis = getRedis();
  const perShard = await Promise.all(
    Array.from(bucketByShard(addresses), async ([key, members]) => {
      const matches: string[] = [];
      for (const batch of chunk(members, SMISMEMBER_CHUNK)) {
        const flags = (await redis.smismember(key, batch)) as number[];
        for (let i = 0; i < batch.length; i += 1) {
          if (flags[i] === 1) matches.push(batch[i]!);
        }
      }
      return matches;
    }),
  );
  return perShard.flat();
}

// ── Cursor helpers ───────────────────────────────────────────────────────────

export async function getLastSyncedBlock(): Promise<bigint> {
  const raw = await getRedis().get<string | number>(LAST_BLOCK_KEY);
  if (raw === null || raw === undefined) return BigInt(0);
  // Parse failure here means Redis was corrupted or written by something
  // outside `setLastSyncedBlock` — surface to Sentry rather than silently
  // resetting the cursor (which would force a full re-pull from Dune).
  return BigInt(String(raw));
}

export async function setLastSyncedBlock(block: bigint): Promise<void> {
  await getRedis().set(LAST_BLOCK_KEY, block.toString());
}

// ── Entry shape ──────────────────────────────────────────────────────────────

/**
 * Build the canonical AddressEntry written by the tagging cron. `name` is
 * generic — humans editing the row in the address book can override it; the
 * `source` marker is the durable provenance signal.
 */
export function toMiniPayEntry(): AddressEntry {
  return sanitizeEntry({
    name: "MiniPay user",
    tags: ["minipay"],
    source: MINIPAY_SOURCE,
    isPublic: false,
    updatedAt: new Date().toISOString(),
  });
}
