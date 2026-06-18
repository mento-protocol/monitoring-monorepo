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

const TRACKED_WALLET_SET = new Set<string>(TRACKED_STETH_WALLETS);

export type StethContext = Pick<
  EvmOnEventContext,
  | "StethCostBasisLot"
  | "StethPosition"
  | "StethYieldMovement"
  | "StethYieldSummary"
  | "isPreload"
>;

export type EventMeta = {
  chainId: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
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
