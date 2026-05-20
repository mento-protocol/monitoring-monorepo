import { getRedis } from "./redis";

export const INTEL_DEEP_KEY = "intel_deep";
const HASH_KEY = INTEL_DEEP_KEY;

// Types

type ArkhamAddress = {
  address: string;
  chain: string;
  isUserAddress: boolean;
  contract: boolean;
  arkhamEntity: { name: string; id: string; type: string } | null;
  arkhamLabel: { name: string; address: string; chainType: string } | null;
  populatedTags: unknown;
};

type ArkhamCounterparty = {
  address: ArkhamAddress;
  usd: number;
  transactionCount: number;
  flow: string;
  chains: string[];
};

export type IntelDeepRecord = {
  address: string;
  fetchedAt: string;
  candidate: {
    address: string;
    priority: number;
    sources: string[];
  };
  enriched: Record<string, ArkhamAddress> | null;
  counterparties: Record<string, ArkhamCounterparty[]> | null;
  entity: unknown;
  contract: unknown;
  error: string | null;
  version: number;
};

export async function getIntelDeep(
  address: string,
): Promise<IntelDeepRecord | null> {
  const redis = getRedis();
  return redis.hget<IntelDeepRecord>(HASH_KEY, address.toLowerCase());
}

export async function getAllIntelDeep(): Promise<
  Record<string, IntelDeepRecord>
> {
  const redis = getRedis();
  const raw = await redis.hgetall<Record<string, IntelDeepRecord>>(HASH_KEY);
  return raw ?? {};
}
