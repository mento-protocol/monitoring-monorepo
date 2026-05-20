import { hgetWithLegacy, hgetallWithLegacy } from "./intel-legacy-fallback";

export const INTEL_TRANSFERS_KEY = "intel_transfers";
const HASH_KEY = INTEL_TRANSFERS_KEY;
const LEGACY_HASH_KEY = "arkham_transfers";

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
  return hgetWithLegacy<IntelTransfersRecord>(
    HASH_KEY,
    LEGACY_HASH_KEY,
    address.toLowerCase(),
  );
}

export async function getAllIntelTransfers(): Promise<
  Record<string, IntelTransfersRecord>
> {
  return hgetallWithLegacy<IntelTransfersRecord>(HASH_KEY, LEGACY_HASH_KEY);
}
