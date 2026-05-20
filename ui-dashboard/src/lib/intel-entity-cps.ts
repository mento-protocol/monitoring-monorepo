import { getRedis } from "./redis";

export const INTEL_ENTITY_CPS_KEY = "intel_entity_cps";
const HASH_KEY = INTEL_ENTITY_CPS_KEY;

// Types

type ArkhamAddressInfo = {
  address: string;
  chain: string;
  arkhamEntity: { name: string; id: string; type: string } | null;
  arkhamLabel: { name: string; address: string; chainType: string } | null;
  isUserAddress: boolean;
  contract: boolean;
};

type EntityCounterparty = {
  address: ArkhamAddressInfo;
  usd: number;
  transactionCount: number;
  flow: string;
  chains: string[];
};

export type IntelEntityCpsRecord = {
  slug: string;
  fetchedAt: string;
  counterparties: Record<string, EntityCounterparty[]> | null;
};

export async function getIntelEntityCps(
  slug: string,
): Promise<IntelEntityCpsRecord | null> {
  const redis = getRedis();
  return redis.hget<IntelEntityCpsRecord>(HASH_KEY, slug);
}

export async function getAllIntelEntityCps(): Promise<
  Record<string, IntelEntityCpsRecord>
> {
  const redis = getRedis();
  const raw =
    await redis.hgetall<Record<string, IntelEntityCpsRecord>>(HASH_KEY);
  return raw ?? {};
}
