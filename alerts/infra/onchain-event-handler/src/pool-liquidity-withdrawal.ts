import { createHash } from "node:crypto";
import {
  createPublicClient,
  decodeEventLog,
  formatUnits,
  http,
  type Hex,
  type Log,
} from "viem";
import { polygon } from "viem/chains";
import {
  getMetadataAccessToken,
  STORAGE_UPLOAD_BASE_URL,
} from "./quicknode-replay-protection";
import { logger } from "./logger";
import { sendToSlack } from "./slack";

const POOL_BURN_TOPIC =
  "0xd175a80c109434bb89948928ab2475a6647c94244cb70002197896423c883363";
const ZERO = "0x0000000000000000000000000000000000000000";
const LEASE_MS = 60_000;
const GCS_REQUEST_TIMEOUT_MS = 10_000;
const poolAbi = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Burn",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "amount0", type: "uint256", indexed: false },
      { name: "amount1", type: "uint256", indexed: false },
      { name: "liquidity", type: "uint256", indexed: false },
      { name: "to", type: "address", indexed: true },
    ],
  },
] as const;

export interface BurnCandidate {
  txHash: Hex;
  logIndex: number;
  watch: PoolWatch;
}
export interface PoolWatch {
  id: string;
  poolAddress: `0x${string}`;
  lpAddress: `0x${string}`;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
}
export interface PoolLiquidityWithdrawal extends BurnCandidate {
  amount0: bigint;
  amount1: bigint;
  liquidity: bigint;
}
type EventKey = { txHash: Hex; logIndex: number; watch: { id: string } };
type Receipt = { status: string; transactionHash: Hex; logs: readonly Log[] };
type Fetch = typeof fetch;
type DeliveryRecord = {
  state: "unverified" | "pending" | "delivered" | "ignored";
  leaseUntil: number;
  event: {
    txHash: Hex;
    logIndex: number;
    watch: PoolWatch;
    amount0: string;
    amount1: string;
    liquidity: string;
  };
  clientMsgId: string;
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";
const isHash = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const isAddress = (value: unknown): value is `0x${string}` =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
function isPoolWatch(value: unknown): value is PoolWatch {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    /^[a-z0-9-]{1,64}$/.test(value.id) &&
    isAddress(value.poolAddress) &&
    isAddress(value.lpAddress) &&
    typeof value.token0Symbol === "string" &&
    /^[A-Za-z0-9]{1,12}$/.test(value.token0Symbol) &&
    typeof value.token1Symbol === "string" &&
    /^[A-Za-z0-9]{1,12}$/.test(value.token1Symbol) &&
    Number.isInteger(value.token0Decimals) &&
    Number(value.token0Decimals) >= 0 &&
    Number(value.token0Decimals) <= 36 &&
    Number.isInteger(value.token1Decimals) &&
    Number(value.token1Decimals) >= 0 &&
    Number(value.token1Decimals) <= 36
  );
}
export function configuredPoolWatches(
  raw = process.env.POOL_LIQUIDITY_WATCHES,
): PoolWatch[] {
  if (!raw) throw new Error("Pool liquidity watch configuration missing");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isPoolWatch))
    throw new Error("Invalid pool liquidity watch configuration");
  const ids = parsed.map((watch) => watch.id);
  if (new Set(ids).size !== ids.length)
    throw new Error("Duplicate pool liquidity watch ID");
  const pairs = parsed.map(
    (watch) =>
      `${watch.poolAddress.toLowerCase()}:${watch.lpAddress.toLowerCase()}`,
  );
  if (new Set(pairs).size !== pairs.length)
    throw new Error("Duplicate pool liquidity watch wallet");
  return parsed;
}
const logNumber = (value: unknown): number | null => {
  const n =
    typeof value === "string" || typeof value === "number"
      ? Number(value)
      : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/** Avoid loading Polygon-only watch configuration for Safe-only batches. */
export function hasPoolBurnLog(body: unknown): boolean {
  if (!isObject(body)) return false;
  const logs: unknown[] = [];
  for (const key of ["result", "data"])
    if (Array.isArray(body[key])) logs.push(...body[key]);
  if (Array.isArray(body.matchingReceipts))
    for (const receipt of body.matchingReceipts)
      if (isObject(receipt) && Array.isArray(receipt.logs))
        logs.push(...receipt.logs);
  return logs.some(
    (log) =>
      isObject(log) &&
      (log.name === "Burn" ||
        (Array.isArray(log.topics) && log.topics[0] === POOL_BURN_TOPIC)),
  );
}

/** Inspect both QuickNode decoded-log and matchingReceipts envelopes. */
export function poolBurnCandidates(
  body: unknown,
  watches = configuredPoolWatches(),
): BurnCandidate[] {
  if (!isObject(body)) return [];
  const entries: Array<{ log: unknown; receipt?: Record<string, unknown> }> =
    [];
  for (const key of ["result", "data"]) {
    if (Array.isArray(body[key]))
      for (const log of body[key]) entries.push({ log });
  }
  if (Array.isArray(body.matchingReceipts)) {
    for (const receipt of body.matchingReceipts) {
      if (!isObject(receipt) || !Array.isArray(receipt.logs)) continue;
      for (const log of receipt.logs) entries.push({ log, receipt });
    }
  }
  const candidates = new Map<string, BurnCandidate>();
  for (const { log, receipt } of entries) {
    if (!isObject(log) || typeof log.address !== "string") continue;
    const matches = watches.filter((watch) =>
      same(log.address as string, watch.poolAddress),
    );
    if (matches.length === 0) continue;
    const topic = Array.isArray(log.topics) ? log.topics[0] : undefined;
    if (log.name !== "Burn" && topic !== POOL_BURN_TOPIC) continue;
    const txHash = log.transactionHash ?? receipt?.transactionHash;
    const logIndex = logNumber(log.logIndex);
    // A matching Burn without an event key must not be silently dropped.
    if (!isHash(txHash) || logIndex === null)
      throw new Error("Watched LP Burn missing transaction hash or log index");
    for (const watch of matches)
      candidates.set(`${watch.id}:${txHash.toLowerCase()}:${logIndex}`, {
        txHash: txHash.toLowerCase() as Hex,
        logIndex,
        watch,
      });
  }
  return [...candidates.values()];
}

function decodePoolLog(log: Log, poolAddress: string) {
  if (!same(log.address, poolAddress)) return null;
  try {
    return {
      index: log.logIndex,
      event: decodeEventLog({
        abi: poolAbi,
        data: log.data,
        topics: log.topics,
      }),
    };
  } catch {
    return null;
  }
}
type PoolLog = NonNullable<ReturnType<typeof decodePoolLog>>;
function transfer(
  entry: PoolLog,
  from: string,
  to: string,
  amount: bigint,
): boolean {
  return (
    entry.event.eventName === "Transfer" &&
    same(entry.event.args.from, from) &&
    same(entry.event.args.to, to) &&
    entry.event.args.value === amount
  );
}

/** Burn.sender and Burn.to can be the Router. The pool LP Transfer proves owner. */
export function provePoolLiquidityWithdrawal(
  candidate: BurnCandidate,
  receipt: Receipt,
): PoolLiquidityWithdrawal | null {
  if (
    receipt.status !== "success" ||
    !same(receipt.transactionHash, candidate.txHash)
  )
    return null;
  const logs = receipt.logs
    .map((log) => decodePoolLog(log, candidate.watch.poolAddress))
    .filter((log): log is PoolLog => log !== null);
  const burnAt = logs.findIndex(
    (log) => log.index === candidate.logIndex && log.event.eventName === "Burn",
  );
  if (burnAt < 0) return null;
  const burn = logs[burnAt].event;
  if (burn.eventName !== "Burn" || burn.args.liquidity <= 0n) return null;
  let previousBurn = -1;
  for (let i = 0; i < burnAt; i++)
    if (logs[i].event.eventName === "Burn") previousBurn = i;
  const transfers = logs
    .slice(previousBurn + 1, burnAt)
    .filter(
      (log) =>
        log.event.eventName === "Transfer" &&
        (same(log.event.args.from, candidate.watch.poolAddress) ||
          same(log.event.args.to, candidate.watch.poolAddress)),
    );
  const destruction = transfers.findIndex((log) =>
    transfer(log, candidate.watch.poolAddress, ZERO, burn.args.liquidity),
  );
  if (
    destruction < 1 ||
    !transfer(
      transfers[destruction - 1],
      candidate.watch.lpAddress,
      candidate.watch.poolAddress,
      burn.args.liquidity,
    )
  ) {
    if (
      transfers.some((log) =>
        transfer(
          log,
          candidate.watch.lpAddress,
          candidate.watch.poolAddress,
          burn.args.liquidity,
        ),
      )
    )
      throw new Error("Ambiguous watched LP transfer before pool burn");
    return null;
  }
  return {
    ...candidate,
    amount0: burn.args.amount0,
    amount1: burn.args.amount1,
    liquidity: burn.args.liquidity,
  };
}

export function poolClientMsgId(event: BurnCandidate): string {
  const bytes = createHash("sha256")
    .update(
      `polygon:137:${event.watch.id}:${event.txHash.toLowerCase()}:${event.logIndex}`,
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function recordName(event: EventKey): string {
  return `pool-liquidity-withdrawals/137/${event.watch.id}/${event.txHash.toLowerCase()}-${event.logIndex}.json`;
}
function objectUrl(bucket: string, event: EventKey): URL {
  return new URL(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(recordName(event))}`,
  );
}
function uploadUrl(bucket: string, event: EventKey, generation: string): URL {
  const url = new URL(
    `${STORAGE_UPLOAD_BASE_URL}/${encodeURIComponent(bucket)}/o`,
  );
  url.searchParams.set("uploadType", "media");
  url.searchParams.set("name", recordName(event));
  url.searchParams.set("ifGenerationMatch", generation);
  return url;
}
async function putRecord(
  fetchImpl: Fetch,
  token: string,
  bucket: string,
  record: DeliveryRecord,
  generation: string,
): Promise<string | null> {
  const response = await fetchImpl(
    uploadUrl(bucket, record.event, generation),
    {
      method: "POST",
      signal: AbortSignal.timeout(GCS_REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(record),
    },
  );
  if (response.status === 412) return null;
  if (!response.ok)
    throw new Error(`Watched LP GCS write failed: ${response.status}`);
  const object = (await response.json()) as { generation?: unknown };
  if (typeof object.generation !== "string")
    throw new Error("Watched LP GCS write missing generation");
  return object.generation;
}
async function readRecord(
  fetchImpl: Fetch,
  token: string,
  bucket: string,
  event: EventKey,
): Promise<{ record: DeliveryRecord; generation: string }> {
  const url = objectUrl(bucket, event);
  const metadataResponse = await fetchImpl(url, {
    signal: AbortSignal.timeout(GCS_REQUEST_TIMEOUT_MS),
    headers: { authorization: `Bearer ${token}` },
  });
  if (!metadataResponse.ok)
    throw new Error(
      `Watched LP GCS metadata read failed: ${metadataResponse.status}`,
    );
  const metadata = (await metadataResponse.json()) as { generation?: unknown };
  if (typeof metadata.generation !== "string")
    throw new Error("Watched LP GCS read missing generation");
  url.searchParams.set("alt", "media");
  url.searchParams.set("ifGenerationMatch", metadata.generation);
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(GCS_REQUEST_TIMEOUT_MS),
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok)
    throw new Error(`Watched LP GCS content read failed: ${response.status}`);
  const record = (await response.json()) as DeliveryRecord;
  if (
    !isPoolWatch(record.event?.watch) ||
    record.event.watch.id !== event.watch.id ||
    record.event?.txHash.toLowerCase() !== event.txHash.toLowerCase() ||
    record.event?.logIndex !== event.logIndex ||
    !["unverified", "pending", "delivered", "ignored"].includes(record.state)
  )
    throw new Error("Watched LP GCS record mismatch");
  return { record, generation: metadata.generation };
}

// Claim the signed event key before RPC proof. Once this write succeeds the
// private retry worker can recover from an RPC outage beyond QuickNode's
// five-minute signature window. A GCS outage before this write still relies on
// QuickNode retry and, if that expires, operator on-chain backfill.
export async function stagePoolCandidate(
  event: BurnCandidate,
  options: { fetchImpl?: Fetch; bucket?: string } = {},
): Promise<void> {
  const bucket = options.bucket ?? process.env.POOL_LIQUIDITY_DELIVERY_BUCKET;
  if (!bucket) throw new Error("Watched LP delivery bucket missing");
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = await getMetadataAccessToken(
    fetchImpl,
    AbortSignal.timeout(GCS_REQUEST_TIMEOUT_MS),
  );
  const record: DeliveryRecord = {
    state: "unverified",
    leaseUntil: 0,
    event: { ...event, amount0: "0", amount1: "0", liquidity: "0" },
    clientMsgId: poolClientMsgId(event),
  };
  await putRecord(fetchImpl, token, bucket, record, "0");
}

export async function stagePoolBurns(
  candidates: BurnCandidate[],
  stage: typeof stagePoolCandidate = stagePoolCandidate,
): Promise<{ staged: BurnCandidate[]; failures: number }> {
  const staged: BurnCandidate[] = [];
  let failures = 0;
  for (const candidate of candidates) {
    try {
      await stage(candidate);
      staged.push(candidate);
    } catch (error) {
      failures++;
      logger.error("Watched LP candidate staging failed", {
        reason: "pool_liquidity_staging_failed",
        transactionHash: candidate.txHash,
        logIndex: candidate.logIndex,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { staged, failures };
}

export async function ignorePoolCandidate(
  event: BurnCandidate,
  options: { fetchImpl?: Fetch; bucket?: string } = {},
): Promise<void> {
  const bucket = options.bucket ?? process.env.POOL_LIQUIDITY_DELIVERY_BUCKET;
  if (!bucket) throw new Error("Watched LP delivery bucket missing");
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = await getMetadataAccessToken(
    fetchImpl,
    AbortSignal.timeout(GCS_REQUEST_TIMEOUT_MS),
  );
  const { record, generation } = await readRecord(
    fetchImpl,
    token,
    bucket,
    event,
  );
  if (record.state !== "unverified") return;
  const updated = await putRecord(
    fetchImpl,
    token,
    bucket,
    { ...record, state: "ignored" },
    generation,
  );
  if (updated === null)
    throw new Error("Watched LP ignored-event state changed concurrently");
}

export async function deliverPoolLiquidityWithdrawal(
  event: PoolLiquidityWithdrawal,
  options: {
    fetchImpl?: Fetch;
    now?: () => number;
    send?: typeof sendToSlack;
    bucket?: string;
    channel?: string;
    token?: string;
  } = {},
): Promise<"delivered" | "already-delivered" | "leased"> {
  const bucket = options.bucket ?? process.env.POOL_LIQUIDITY_DELIVERY_BUCKET;
  const channel = options.channel ?? process.env.POOL_ALERT_CHANNEL_ID;
  const botToken = options.token ?? process.env.SLACK_BOT_TOKEN;
  if (!bucket || !channel || !botToken)
    throw new Error("Watched LP delivery configuration missing");
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const token = await getMetadataAccessToken(
    fetchImpl,
    AbortSignal.timeout(GCS_REQUEST_TIMEOUT_MS),
  );
  const record: DeliveryRecord = {
    state: "pending",
    leaseUntil: now() + LEASE_MS,
    event: {
      txHash: event.txHash,
      logIndex: event.logIndex,
      watch: event.watch,
      amount0: event.amount0.toString(),
      amount1: event.amount1.toString(),
      liquidity: event.liquidity.toString(),
    },
    clientMsgId: poolClientMsgId(event),
  };
  let generation = await putRecord(fetchImpl, token, bucket, record, "0");
  if (generation === null) {
    const prior = await readRecord(fetchImpl, token, bucket, event);
    if (prior.record.state === "delivered") return "already-delivered";
    if (prior.record.state === "ignored")
      throw new Error("Watched LP delivery state already ignored");
    if (prior.record.leaseUntil > now()) return "leased";
    generation = await putRecord(
      fetchImpl,
      token,
      bucket,
      record,
      prior.generation,
    );
    if (generation === null) return "leased";
  }
  const { watch } = event;
  const text = `Watched LP removed liquidity — ${watch.token0Symbol}/${watch.token1Symbol} · Polygon. Gross pool outflow: ${formatUnits(event.amount0, watch.token0Decimals)} ${watch.token0Symbol} + ${formatUnits(event.amount1, watch.token1Decimals)} ${watch.token1Symbol}. The transaction may also swap tokens. <https://monitoring.mento.org/pool/137-${watch.poolAddress}|Pool> · <https://polygonscan.com/address/${watch.lpAddress}|LP wallet> · <https://polygonscan.com/tx/${event.txHash}|Polygon transaction> · burn log ${event.logIndex}.`;
  await (options.send ?? sendToSlack)(
    botToken,
    channel,
    { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] },
    // Bound Slack's Retry-After sleep and HTTP retries below the GCS lease.
    // A late Slack ack can still race the durable commit (at-least-once).
    AbortSignal.timeout(45_000),
    record.clientMsgId,
  );
  const committed = await putRecord(
    fetchImpl,
    token,
    bucket,
    { ...record, state: "delivered", leaseUntil: 0 },
    generation,
  );
  if (committed === null)
    throw new Error("Watched LP delivery record changed after Slack post");
  return "delivered";
}

export async function processPoolBurns(
  candidates: BurnCandidate[],
  options: {
    receipt?: (hash: Hex) => Promise<Receipt>;
    deliver?: typeof deliverPoolLiquidityWithdrawal;
    stage?: typeof stagePoolCandidate;
    ignore?: typeof ignorePoolCandidate;
  } = {},
): Promise<void> {
  if (candidates.length === 0) return;
  // Attempt every durable claim before receipt proof. A failed claim remains
  // fatal to the webhook response, but must not strand successfully claimed
  // siblings or prevent their immediate delivery.
  const { staged, failures: stagingFailures } = await stagePoolBurns(
    candidates,
    options.stage,
  );
  let failures = stagingFailures;
  const receiptClient =
    options.receipt ??
    ((hash: Hex) =>
      createPublicClient({
        chain: polygon,
        transport: http(process.env.RPC_URL_137 || "https://polygon.drpc.org", {
          timeout: 10_000,
        }),
      }).getTransactionReceipt({ hash }));
  const cache = new Map<string, Receipt>();
  for (const candidate of staged) {
    try {
      let receipt = cache.get(candidate.txHash);
      if (!receipt) {
        receipt = await receiptClient(candidate.txHash);
        cache.set(candidate.txHash, receipt);
      }
      const event = provePoolLiquidityWithdrawal(candidate, receipt);
      if (!event) {
        await (options.ignore ?? ignorePoolCandidate)(candidate);
        continue;
      }
      const result = await (options.deliver ?? deliverPoolLiquidityWithdrawal)(
        event,
      );
      if (result === "leased")
        throw new Error("Watched LP event delivery lease still active");
    } catch (error) {
      failures++;
      logger.error("Watched LP candidate processing failed", {
        reason: "pool_liquidity_processing_failed",
        transactionHash: candidate.txHash,
        logIndex: candidate.logIndex,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (failures)
    throw new Error(
      `Watched LP delivery left ${failures} candidate(s) pending`,
    );
}

/** Independently retry persisted events after QuickNode's signed retry window. */
export async function retryPendingPoolLiquidityWithdrawals(
  options: {
    fetchImpl?: Fetch;
    bucket?: string;
    deliver?: typeof deliverPoolLiquidityWithdrawal;
    verify?: typeof processPoolBurns;
    now?: () => number;
  } = {},
): Promise<number> {
  const bucket = options.bucket ?? process.env.POOL_LIQUIDITY_DELIVERY_BUCKET;
  if (!bucket) throw new Error("Watched LP retry bucket missing");
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = await getMetadataAccessToken(
    fetchImpl,
    AbortSignal.timeout(GCS_REQUEST_TIMEOUT_MS),
  );
  const now = options.now ?? Date.now;
  const scanStartedAt = now();
  const deadline = scanStartedAt + 240_000;
  let pageToken: string | undefined;
  let pageCount = 0;
  let attempted = 0;
  let failures = 0;
  let capReached = false;
  const keys: EventKey[] = [];
  do {
    if (++pageCount > 20)
      throw new Error(
        "Watched LP retry scan exceeded 20 pages; delivery state needs operator inspection",
      );
    const url = new URL(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`,
    );
    url.searchParams.set("prefix", "pool-liquidity-withdrawals/137/");
    url.searchParams.set("maxResults", "1000");
    url.searchParams.set("fields", "items(name),nextPageToken");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(GCS_REQUEST_TIMEOUT_MS),
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok)
      throw new Error(`Watched LP retry list failed: ${response.status}`);
    const page = (await response.json()) as {
      items?: Array<{ name?: string }>;
      nextPageToken?: string;
    };
    for (const item of page.items ?? []) {
      if (now() >= deadline)
        throw new Error("Watched LP retry scan reached processing budget");
      const match =
        /^pool-liquidity-withdrawals\/137\/([a-z0-9-]{1,64})\/(0x[0-9a-f]{64})-(\d+)\.json$/.exec(
          item.name ?? "",
        );
      if (!match) throw new Error("Unexpected Watched LP delivery object name");
      keys.push({
        watch: { id: match[1] },
        txHash: match[2] as Hex,
        logIndex: Number(match[3]),
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  // Rotate the bounded attempt window by one batch each Scheduler minute.
  // Persistently failing early keys must not starve later withdrawals. The
  // complete name scan is bounded by the page and time budgets above.
  const start = keys.length
    ? (Math.floor(scanStartedAt / 60_000) * 25) % keys.length
    : 0;
  for (let offset = 0; offset < keys.length; offset++) {
    if (now() >= deadline)
      throw new Error("Watched LP retry scan reached processing budget");
    const key = keys[(start + offset) % keys.length];
    try {
      const { record } = await readRecord(fetchImpl, token, bucket, key);
      if (
        record.state === "delivered" ||
        record.state === "ignored" ||
        record.leaseUntil > now()
      )
        continue;
      if (attempted >= 25) {
        capReached = true;
        break;
      }
      attempted++;
      if (record.state === "unverified") {
        await (options.verify ?? processPoolBurns)([
          { ...key, watch: record.event.watch },
        ]);
        continue;
      }
      const event: PoolLiquidityWithdrawal = {
        ...key,
        watch: record.event.watch,
        amount0: BigInt(record.event.amount0),
        amount1: BigInt(record.event.amount1),
        liquidity: BigInt(record.event.liquidity),
      };
      await (options.deliver ?? deliverPoolLiquidityWithdrawal)(event);
    } catch (error) {
      failures++;
      logger.error("Watched LP retry event failed", {
        reason: "pool_liquidity_retry_event_failed",
        transactionHash: key.txHash,
        logIndex: key.logIndex,
        error: error instanceof Error ? error.message : String(error),
      });
      // Keep scanning so one Slack error does not starve other pending events.
      if (failures > 25) throw error;
    }
    if (capReached) break;
  }
  if (capReached)
    throw new Error("Watched LP retry exceeded 25 pending events in one run");
  if (failures)
    throw new Error(`Watched LP retry left ${failures} event(s) pending`);
  return attempted;
}
