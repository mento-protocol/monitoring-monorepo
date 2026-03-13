/**
 * Protocol fee tracking via ERC20 Transfer events to the yield split address.
 *
 * Queries Transfer logs where `to = YIELD_SPLIT_ADDRESS`, converts amounts
 * to USD using known stablecoin rates, and returns total + 24h aggregates.
 */

import { parseAbiItem } from "viem";
import type { Network } from "./networks";
import { tokenSymbol } from "./tokens";
import { parseWei } from "./format";
import { getViemClient, ERC20_ABI } from "./rpc-client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const YIELD_SPLIT_ADDRESS =
  "0x0Dd57F6f181D0469143fe9380762d8a112e96e4a" as const;

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/** Tokens treated as $1.00 for USD conversion. */
const USD_PEGGED_SYMBOLS = new Set(["cUSD", "USDC", "axlUSDC", "USDT", "USDm"]);

/**
 * Approximate FX rates for non-USD stablecoins.
 * Hardcoded for v1 — acceptable for a monitoring dashboard.
 * A future iteration could pull live rates from on-chain oracles.
 */
const FX_RATES: Record<string, number> = {
  cEUR: 1.08,
  GBPm: 1.27,
  KESm: 0.0077,
};

/**
 * First block where the yield split address received fees, per chain.
 * Avoids scanning from genesis.
 */
const DEPLOYMENT_BLOCKS: Record<number, bigint> = {
  42220: BigInt(30_000_000), // Celo mainnet — conservative estimate
  143: BigInt(0), // Monad mainnet
};

const ZERO = BigInt(0);
const ONE = BigInt(1);
const SECONDS_PER_DAY = BigInt(86400);
const CHUNK_SIZE = BigInt(50_000);

/** Average block time per chain in seconds. Used to estimate the 24h-ago block. */
const BLOCK_TIMES: Record<number, number> = {
  42220: 5, // Celo
  143: 1, // Monad
};

// ---------------------------------------------------------------------------
// Token decimals cache (bounded by number of fee-generating tokens, ~10-20)
// ---------------------------------------------------------------------------

const decimalsCache = new Map<string, number>();

async function getDecimals(
  client: ReturnType<typeof getViemClient>,
  tokenAddress: `0x${string}`,
): Promise<number> {
  const key = tokenAddress.toLowerCase();
  const cached = decimalsCache.get(key);
  if (cached !== undefined) return cached;

  try {
    const d = await client.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "decimals",
    });
    const num = Number(d);
    decimalsCache.set(key, num);
    return num;
  } catch {
    // Default to 18 if the call fails
    decimalsCache.set(key, 18);
    return 18;
  }
}

// ---------------------------------------------------------------------------
// USD conversion
// ---------------------------------------------------------------------------

function tokenToUSD(symbol: string, amount: number): number {
  if (USD_PEGGED_SYMBOLS.has(symbol)) return amount;
  const rate = FX_RATES[symbol];
  if (rate !== undefined) return amount * rate;
  // Unknown token — log so operators can add it to USD_PEGGED_SYMBOLS or FX_RATES
  console.warn(
    `[protocol-fees] Unknown fee token "${symbol}" — excluded from USD total`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Core fetcher — single scan with split block
// ---------------------------------------------------------------------------

/**
 * Fetches Transfer events to the yield split address and aggregates USD value.
 * Chunks the log query to stay within RPC provider limits.
 *
 * If `splitBlock` is provided, returns two totals: one for blocks before the
 * split (pre-window) and one for blocks at or after the split (in-window).
 * This avoids scanning overlapping ranges for total vs. 24h fees.
 */
async function fetchTransferUSD(
  client: ReturnType<typeof getViemClient>,
  network: Network,
  fromBlock: bigint,
  toBlock: bigint,
  splitBlock?: bigint,
): Promise<{ total: number; sinceplit: number }> {
  let total = 0;
  let sinceSplit = 0;

  for (let start = fromBlock; start <= toBlock; start += CHUNK_SIZE) {
    const end =
      start + CHUNK_SIZE - ONE > toBlock ? toBlock : start + CHUNK_SIZE - ONE;

    const logs = await client.getLogs({
      event: TRANSFER_EVENT,
      args: { to: YIELD_SPLIT_ADDRESS },
      fromBlock: start,
      toBlock: end,
    });

    for (const log of logs) {
      const tokenAddress = log.address;
      const rawValue = log.args.value ?? ZERO;
      if (rawValue === ZERO) continue;

      const decimals = await getDecimals(client, tokenAddress);
      const amount = parseWei(String(rawValue), decimals);
      const symbol = tokenSymbol(network, tokenAddress);
      const usd = tokenToUSD(symbol, amount);

      total += usd;
      if (splitBlock !== undefined && log.blockNumber >= splitBlock) {
        sinceSplit += usd;
      }
    }
  }

  return { total, sinceplit: sinceSplit };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ProtocolFeeSummary = {
  totalFeesUSD: number;
  fees24hUSD: number;
};

export async function fetchProtocolFeeSummary(
  rpcUrl: string,
  network: Network,
): Promise<ProtocolFeeSummary> {
  const client = getViemClient(rpcUrl);
  const latest = await client.getBlock({ blockTag: "latest" });
  const latestBlock = latest.number;
  const deploymentBlock = DEPLOYMENT_BLOCKS[network.chainId] ?? ZERO;

  // Estimate 24h-ago block from average block time (no binary search needed —
  // a few blocks of imprecision is negligible for a fee aggregate).
  const blockTime = BigInt(BLOCK_TIMES[network.chainId] ?? 5);
  let block24hAgo = latestBlock - SECONDS_PER_DAY / blockTime;
  if (block24hAgo < deploymentBlock) block24hAgo = deploymentBlock;

  // Single scan of the full range, splitting at the 24h boundary
  const { total, sinceplit } = await fetchTransferUSD(
    client,
    network,
    deploymentBlock,
    latestBlock,
    block24hAgo,
  );

  return { totalFeesUSD: total, fees24hUSD: sinceplit };
}
