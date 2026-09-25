import { decodeEventLog, type Log } from "viem";

export const CAPA_POOL_ID = "137-0x93e15a22fda39fefccce82d387a09ccf030ead61";
export const CAPA_POOL_ADDRESS = "0x93e15a22fda39fefccce82d387a09ccf030ead61";
// Philip confirmed this Polygon LP Safe as Capa's on 2026-09-25. Every alert
// still requires receipt-level proof that this address actually burned LP.
export const CAPA_LP_OWNER = "0x3d54f9496bf5bd0afa67c80ee8bc2eeadf306381";

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

export type IndexedBurn = {
  id: string;
  poolId: string;
  kind: string;
  amount0: string;
  amount1: string;
  liquidity: string;
  txHash: string;
  blockNumber: string;
  blockTimestamp: string;
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";
type Receipt = {
  status: string;
  transactionHash: string;
  blockNumber: bigint;
  logs: readonly Log[];
};

function decodePoolLog(log: Log) {
  if (!same(log.address, CAPA_POOL_ADDRESS)) return null;
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

function matchesIndexedBurn(
  row: IndexedBurn,
  entry: PoolLog | undefined,
): boolean {
  const burn = entry?.event;
  return (
    burn?.eventName === "Burn" &&
    entry?.index === Number(row.id.split("_").at(-1)) &&
    burn.args.liquidity === BigInt(row.liquidity) &&
    burn.args.amount0 === BigInt(row.amount0) &&
    burn.args.amount1 === BigInt(row.amount1)
  );
}

function isTransfer(
  entry: PoolLog,
  from: string,
  to: string,
  value: bigint,
): boolean {
  const event = entry.event;
  return (
    event.eventName === "Transfer" &&
    same(event.args.from, from) &&
    same(event.args.to, to) &&
    event.args.value === value
  );
}

function ownerSentBurnedLp(
  logs: PoolLog[],
  burnAt: number,
  owner: string,
  liquidity: bigint,
): boolean {
  let previousBurn = -1;
  for (let i = 0; i < burnAt; i += 1) {
    if (logs[i]?.event.eventName === "Burn") previousBurn = i;
  }
  const transfers = logs
    .slice(previousBurn + 1, burnAt)
    .filter((entry) => entry.event.eventName === "Transfer");
  const destroyedAt = transfers.findIndex((entry) =>
    isTransfer(entry, CAPA_POOL_ADDRESS, ZERO, liquidity),
  );
  if (destroyedAt < 1) return false;
  const sentToPool = transfers[destroyedAt - 1];
  return (
    sentToPool !== undefined &&
    isTransfer(sentToPool, owner, CAPA_POOL_ADDRESS, liquidity)
  );
}

// Burn.sender is the Router on Polygon, and Burn.to can be the Router too.
// Only the pool's LP-token Transfer(owner -> pool) proves who withdrew.
export function isOwnerWithdrawal(
  row: IndexedBurn,
  receipt: Receipt,
  owner: string,
): boolean {
  if (
    row.poolId !== CAPA_POOL_ID ||
    row.kind !== "BURN" ||
    receipt.status !== "success" ||
    !same(row.txHash, receipt.transactionHash) ||
    receipt.blockNumber !== BigInt(row.blockNumber) ||
    !/^0x[0-9a-fA-F]{40}$/.test(owner)
  )
    return false;

  if (BigInt(row.liquidity) <= 0n) return false;
  const poolLogs = receipt.logs
    .map(decodePoolLog)
    .filter((log) => log !== null);
  const burnAt = poolLogs.findIndex((entry) => matchesIndexedBurn(row, entry));
  return (
    burnAt >= 0 &&
    ownerSentBurnedLp(poolLogs, burnAt, owner, BigInt(row.liquidity))
  );
}
