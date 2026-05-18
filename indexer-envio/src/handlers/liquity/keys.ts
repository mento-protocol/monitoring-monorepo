export const pendingTroveKey = (
  chainId: number,
  txHash: string,
  collateralId: string,
  troveId: bigint | string,
): string => `${chainId}-${txHash}-${collateralId}-${troveId.toString()}`;
