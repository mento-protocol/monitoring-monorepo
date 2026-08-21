import type { EvmOnEventContext } from "envio";
import { asAddress } from "../../helpers.js";

export const ETHEREUM_CHAIN_ID = 1;
export const SUSDS_ADDRESS = "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd";
export const TRACKED_SUSDS_WALLETS = [
  "0xd0697f70e79476195b742d5afab14be50f98cc1e",
  "0xd3d2e5c5af667da817b2d752d86c8f40c22137e1",
] as const;

export const WAD = 10n ** 18n;
export const ZERO = 0n;
export const SUMMARY_ID = `${ETHEREUM_CHAIN_ID}-susds`;
export const V3_REVENUE_LAUNCH_TIMESTAMP = 1_772_496_000n; // 2026-03-03T00:00:00Z
// Last Ethereum block before the v3 revenue launch timestamp. Keep the
// baseline at this exact block so the launch-day row starts at pre-launch
// share price while its UTC bucket starts at the v3 launch timestamp.
export const V3_REVENUE_LAUNCH_BLOCK = 24_573_203;
// Roughly every two Ethereum hours. Daily rows do not need an every-block
// heartbeat, but this cadence captures quiet-period sUSDS share-price growth.
export const SUSDS_DAILY_SNAPSHOT_BLOCK_INTERVAL = 600;

const TRACKED_WALLET_SET = new Set<string>(TRACKED_SUSDS_WALLETS);

export type SusdsContext = Pick<
  EvmOnEventContext,
  | "SusdsCostBasisLot"
  | "SusdsPosition"
  | "SusdsYieldMovement"
  | "SusdsYieldDailySnapshot"
  | "SusdsYieldSummary"
  | "effect"
  | "isPreload"
>;

export type BlockMeta = {
  chainId: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
};

export type EventMeta = BlockMeta & {
  logIndex: number;
  txHash: string;
};

export type SusdsYieldTotals = {
  currentShares: bigint;
  costBasisUsdWei: bigint;
  realizedYieldUsdWei: bigint;
  transferredOutYieldUsdWei: bigint;
  redeemedYieldUsdWei: bigint;
  currentValueUsdWei: bigint;
  unrealizedYieldUsdWei: bigint;
  totalEarnedYieldUsdWei: bigint;
};

export function isTrackedWallet(address: string): boolean {
  return TRACKED_WALLET_SET.has(asAddress(address));
}

export function positionId(chainId: number, wallet: string): string {
  return `${chainId}-${wallet}`;
}

export function valueForShares(
  shares: bigint,
  sharePriceUsdWei: bigint,
): bigint {
  return (shares * sharePriceUsdWei) / WAD;
}

export function positiveDelta(value: bigint, basis: bigint): bigint {
  return value > basis ? value - basis : ZERO;
}
