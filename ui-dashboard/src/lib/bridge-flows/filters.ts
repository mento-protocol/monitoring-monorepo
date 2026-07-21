import type { BridgeStatus } from "@/lib/types";

export type BridgeTransferWhere = {
  status: { _in: BridgeStatus[] };
  sourceChainId?: { _eq: number };
  destChainId?: { _eq: number };
};

export function buildBridgeTransferWhere(
  statusIn: BridgeStatus[],
  sourceChainId: number | null,
  destChainId: number | null,
): BridgeTransferWhere {
  return {
    status: { _in: statusIn },
    ...(sourceChainId === null
      ? {}
      : { sourceChainId: { _eq: sourceChainId } }),
    ...(destChainId === null ? {} : { destChainId: { _eq: destChainId } }),
  };
}

export function parseBridgeChainId(
  value: string | null,
  allowedChainIds: ReadonlySet<number>,
): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const chainId = Number(value);
  return allowedChainIds.has(chainId) ? chainId : null;
}
