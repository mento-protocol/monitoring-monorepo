import { decodeEventLog, type Hex, type Log } from "viem";

const POOL_BURN_TOPIC =
  "0xd175a80c109434bb89948928ab2475a6647c94244cb70002197896423c883363";
const ZERO = "0x0000000000000000000000000000000000000000";
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
export type Receipt = {
  status: string;
  transactionHash: Hex;
  logs: readonly Log[];
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";
const isHash = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const isAddress = (value: unknown): value is `0x${string}` =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
export function isPoolWatch(value: unknown): value is PoolWatch {
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
  onMalformed?: () => void,
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
    if (!isHash(txHash) || logIndex === null) {
      if (!onMalformed)
        throw new Error(
          "Watched LP Burn missing transaction hash or log index",
        );
      onMalformed();
      continue;
    }
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
function watchedContribution(
  entry: PoolLog,
  candidate: BurnCandidate,
): boolean {
  return (
    entry.event.eventName === "Transfer" &&
    same(entry.event.args.from, candidate.watch.lpAddress) &&
    same(entry.event.args.to, candidate.watch.poolAddress)
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
  const beforeDestruction =
    destruction < 0 ? transfers : transfers.slice(0, destruction);
  let contributed = 0n;
  for (let i = destruction - 1; i >= 0; i--) {
    const log = transfers[i];
    if (!watchedContribution(log, candidate)) break;
    if (log.event.eventName === "Transfer") contributed += log.event.args.value;
  }
  if (destruction < 1 || contributed !== burn.args.liquidity) {
    // A partial or interleaved watched-wallet contribution is a real on-chain
    // signal, but it cannot prove ownership of this entire Burn. Keep the
    // durable record pending and page an operator instead of marking it ignored.
    if (beforeDestruction.some((log) => watchedContribution(log, candidate)))
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
