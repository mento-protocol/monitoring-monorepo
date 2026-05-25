import { hgetWithLegacy, hgetallWithLegacy } from "./intel-legacy-fallback";

export const INTEL_DEEP_KEY = "intel_deep";
const HASH_KEY = INTEL_DEEP_KEY;
const LEGACY_HASH_KEY = "arkham_deep";

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
  return hgetWithLegacy<IntelDeepRecord>(HASH_KEY, LEGACY_HASH_KEY, address);
}

export async function getAllIntelDeep(): Promise<
  Record<string, IntelDeepRecord>
> {
  return hgetallWithLegacy<IntelDeepRecord>(HASH_KEY, LEGACY_HASH_KEY);
}
