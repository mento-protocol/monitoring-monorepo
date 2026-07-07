import type { EvmOnEventContext } from "envio";
import { asAddress } from "../../helpers.js";

export const ETHEREUM_CHAIN_ID = 1;
export const STETH_ADDRESS = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
// Mirror: ui-dashboard/src/lib/reserve-yield-steth.ts TRACKED_STETH_WALLET_IDENTIFIERS.
// Keep both in sync when tracked reserve wallets change.
export const TRACKED_STETH_WALLETS = [
  "0xd0697f70e79476195b742d5afab14be50f98cc1e",
  "0xd3d2e5c5af667da817b2d752d86c8f40c22137e1",
] as const;

export const ZERO = 0n;
export const SUMMARY_ID = `${ETHEREUM_CHAIN_ID}-steth`;
export const FIRST_TRACKED_STETH_BLOCK = 19_111_760;
export const FIRST_TRACKED_STETH_TX =
  "0x297cbad231aa43b915ade1b699b8b0257babe6fff0b62e564d422daace021731";
export const V3_REVENUE_LAUNCH_TIMESTAMP = 1_772_496_000n; // 2026-03-03T00:00:00Z
// Last Ethereum block before the v3 revenue launch timestamp. Derived via
// ethereum.publicnode.com RPC on 2026-07-07:
// block 24573203 timestamp 1772495999; block 24573204 timestamp 1772496011.
export const V3_REVENUE_LAUNCH_BLOCK = 24_573_203;
export const STETH_DAILY_SNAPSHOT_BLOCK_INTERVAL = 7_200;

const TRACKED_WALLET_SET = new Set<string>(TRACKED_STETH_WALLETS);

export type StethContext = Pick<
  EvmOnEventContext,
  | "StethCostBasisLot"
  | "StethPosition"
  | "StethWalletLaunchBaseline"
  | "StethYieldDailySnapshot"
  | "StethYieldMovement"
  | "StethYieldSummary"
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

export type StethYieldTotals = {
  currentBalance: bigint;
  remainingPrincipalAmount: bigint;
  realizedYieldAmount: bigint;
  transferredOutYieldAmount: bigint;
  unrealizedYieldAmount: bigint;
  totalEarnedYieldAmount: bigint;
};

export function isTrackedWallet(address: string): boolean {
  return TRACKED_WALLET_SET.has(asAddress(address));
}

export function positionId(chainId: number, wallet: string): string {
  return `${chainId}-${wallet}`;
}

export function positiveDelta(value: bigint, basis: bigint): bigint {
  return value > basis ? value - basis : ZERO;
}
