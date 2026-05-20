import { getRedis } from "./redis";

export const INTEL_WEALTH_KEY = "intel_wealth";
const HASH_KEY = INTEL_WEALTH_KEY;

// Types

type TokenBalance = {
  name: string;
  symbol: string;
  id: string;
  balance: number;
  balanceExact: string;
  usd: number;
  price: number;
  quoteTime: string;
  priceChange24hPercent: number;
  priceChange24h: number;
};

type BalancesSection = {
  addresses: Record<string, unknown>;
  totalBalance: Record<string, number>;
  totalBalance24hAgo: Record<string, number>;
  balances: Record<string, TokenBalance[]>;
};

type PortfolioEntry = {
  ts: number;
  /** Raw Arkham portfolio response — shape varies; consumers drill deeper. */
  data: unknown;
};

export type IntelWealthRecord = {
  address: string;
  fetchedAt: string;
  sources: string[];
  balances: BalancesSection | null;
  portfolio: Record<string, PortfolioEntry> | null;
  version: number;
};

export async function getIntelWealth(
  address: string,
): Promise<IntelWealthRecord | null> {
  const redis = getRedis();
  return redis.hget<IntelWealthRecord>(HASH_KEY, address.toLowerCase());
}

export async function getAllIntelWealth(): Promise<
  Record<string, IntelWealthRecord>
> {
  const redis = getRedis();
  const raw = await redis.hgetall<Record<string, IntelWealthRecord>>(HASH_KEY);
  return raw ?? {};
}
