import { getRedis } from "./redis";

export const INTEL_TRANSFERS_KEY = "intel_transfers";
const HASH_KEY = INTEL_TRANSFERS_KEY;

// Types

type ArkhamAddressInfo = {
  address: string;
  chain: string;
  isUserAddress: boolean;
  contract: boolean;
  arkhamEntity: { name: string; id: string; type: string } | null;
  arkhamLabel: { name: string; address: string; chainType: string } | null;
};

type ArkhamTransfer = {
  id: string;
  transactionHash: string;
  fromAddress: ArkhamAddressInfo;
  fromIsContract: boolean;
  toAddress: ArkhamAddressInfo;
  toIsContract: boolean;
  tokenAddress: string;
  type: string;
  blockTimestamp: string;
  blockNumber: number;
  blockHash: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimals: number;
  unitValue: number;
  tokenId: string | null;
  historicalUSD: number;
  chain: string;
};

export type IntelTransfersRecord = {
  address: string;
  label?: string;
  fetchedAt: string;
  transferCount: number;
  transfers: ArkhamTransfer[] | null;
};

export async function getIntelTransfers(
  address: string,
): Promise<IntelTransfersRecord | null> {
  const redis = getRedis();
  return redis.hget<IntelTransfersRecord>(HASH_KEY, address.toLowerCase());
}

export async function getAllIntelTransfers(): Promise<
  Record<string, IntelTransfersRecord>
> {
  const redis = getRedis();
  const raw =
    await redis.hgetall<Record<string, IntelTransfersRecord>>(HASH_KEY);
  return raw ?? {};
}
