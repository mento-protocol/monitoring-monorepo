import { createHash } from "node:crypto";
import { createPublicClient, formatUnits, http, type Hex } from "viem";
import { polygon } from "viem/chains";
import {
  getMetadataAccessToken,
  STORAGE_UPLOAD_BASE_URL,
} from "./quicknode-replay-protection";
import { logger } from "./logger";
import { sendToSlack } from "./slack";
import { scanPoolDeliveryKeys } from "./pool-liquidity-scan";
import {
  configuredPoolWatches,
  hasPoolBurnLog,
  isPoolWatch,
  poolBurnCandidates,
  provePoolLiquidityWithdrawal,
  type BurnCandidate,
  type PoolLiquidityWithdrawal,
  type PoolWatch,
  type Receipt,
} from "./pool-liquidity-proof";

export {
  configuredPoolWatches,
  hasPoolBurnLog,
  poolBurnCandidates,
  provePoolLiquidityWithdrawal,
};
export type { BurnCandidate, PoolLiquidityWithdrawal };

const LEASE_MS = 60_000;
const GCS_REQUEST_TIMEOUT_MS = 10_000;
// The function/Scheduler stop at 300s. Reserve 155s for one final record's
// bounded RPC/GCS/Slack calls and a cursor checkpoint.
const RETRY_SCAN_BUDGET_MS = 145_000;
type EventKey = { txHash: Hex; logIndex: number; watch: { id: string } };
type Fetch = typeof fetch;
const CANDIDATE_PREFIX = "pool-liquidity-candidates";
const STATE_PREFIX = "pool-liquidity-withdrawals";
class MissingRecordError extends Error {}
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

function recordName(event: EventKey, prefix = STATE_PREFIX): string {
  return `${prefix}/137/${event.watch.id}/${event.txHash.toLowerCase()}-${event.logIndex}.json`;
}
function objectUrl(
  bucket: string,
  event: EventKey,
  prefix = STATE_PREFIX,
): URL {
  return new URL(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(recordName(event, prefix))}`,
  );
}
function uploadUrl(
  bucket: string,
  event: EventKey,
  generation: string,
  prefix = STATE_PREFIX,
): URL {
  const url = new URL(
    `${STORAGE_UPLOAD_BASE_URL}/${encodeURIComponent(bucket)}/o`,
  );
  url.searchParams.set("uploadType", "media");
  url.searchParams.set("name", recordName(event, prefix));
  url.searchParams.set("ifGenerationMatch", generation);
  return url;
}
async function putRecord(
  fetchImpl: Fetch,
  token: string,
  bucket: string,
  record: DeliveryRecord,
  generation: string,
  prefix = STATE_PREFIX,
): Promise<string | null> {
  const response = await fetchImpl(
    uploadUrl(bucket, record.event, generation, prefix),
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
  if (metadataResponse.status === 404)
    throw new MissingRecordError("Delivery state missing");
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
  const bucket = options.bucket ?? process.env.POOL_LIQUIDITY_CANDIDATE_BUCKET;
  if (!bucket) throw new Error("Watched LP candidate bucket missing");
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
  await putRecord(fetchImpl, token, bucket, record, "0", CANDIDATE_PREFIX);
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
  const record: DeliveryRecord = {
    state: "ignored",
    leaseUntil: 0,
    event: { ...event, amount0: "0", amount1: "0", liquidity: "0" },
    clientMsgId: poolClientMsgId(event),
  };
  const updated = await putRecord(fetchImpl, token, bucket, record, "0");
  if (updated === null) {
    const prior = await readRecord(fetchImpl, token, bucket, event);
    if (prior.record.state === "ignored" || prior.record.state === "delivered")
      return;
    throw new Error("Watched LP ignored-event state changed concurrently");
  }
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
    candidateBucket?: string;
    stateBucket?: string;
    watches?: PoolWatch[];
    deliver?: typeof deliverPoolLiquidityWithdrawal;
    verify?: typeof processPoolBurns;
    now?: () => number;
  } = {},
): Promise<number> {
  const candidateBucket =
    options.candidateBucket ?? process.env.POOL_LIQUIDITY_CANDIDATE_BUCKET;
  const stateBucket =
    options.stateBucket ?? process.env.POOL_LIQUIDITY_DELIVERY_BUCKET;
  if (!candidateBucket || !stateBucket)
    throw new Error("Watched LP retry buckets missing");
  const watches = options.watches ?? configuredPoolWatches();
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = await getMetadataAccessToken(
    fetchImpl,
    AbortSignal.timeout(GCS_REQUEST_TIMEOUT_MS),
  );
  const now = options.now ?? Date.now;
  const scanStartedAt = now();
  const deadline = scanStartedAt + RETRY_SCAN_BUDGET_MS;
  let attempted = 0;
  let failures = 0;
  const scan = await scanPoolDeliveryKeys({
    fetchImpl,
    token,
    candidateBucket,
    stateBucket,
    now,
    deadline,
    onKey: async (key) => {
      try {
        let record: DeliveryRecord | null;
        try {
          record = (await readRecord(fetchImpl, token, stateBucket, key))
            .record;
        } catch (error) {
          if (!(error instanceof MissingRecordError)) throw error;
          record = null;
        }
        if (!record) {
          const watch = watches.find((item) => item.id === key.watch.id);
          if (!watch)
            throw new Error("Watched LP candidate has no configured watch");
          attempted++;
          await (options.verify ?? processPoolBurns)([{ ...key, watch }], {
            stage: async () => {},
          });
          return;
        }
        if (
          record.state === "delivered" ||
          record.state === "ignored" ||
          record.leaseUntil > now()
        )
          return;
        attempted++;
        if (record.state === "unverified")
          throw new Error("Unverified state in private delivery bucket");
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
      }
    },
  });
  if (scan.incomplete)
    logger.error("Watched LP retry scan incomplete", {
      reason: "pool_liquidity_retry_scan_incomplete",
      attempted,
    });
  if (failures)
    throw new Error(`Watched LP retry left ${failures} event(s) pending`);
  return attempted;
}
