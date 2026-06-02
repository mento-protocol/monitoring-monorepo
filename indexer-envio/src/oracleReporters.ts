import type { RateFeed } from "envio";
import oracleReportersJson from "../config/oracle-reporters.json" with { type: "json" };
import { asAddress } from "./helpers.js";

export const ORACLE_REPORTER_TYPES = [
  "CHAINLINK",
  "REDSTONE",
  "BRIDGED",
  "MANUAL",
] as const;

export type OracleReporterType = (typeof ORACLE_REPORTER_TYPES)[number];

type RawFeedEntry = {
  pair: string;
};

type RawReporterEntry = {
  type?: string;
};

type RawChainEntry = {
  feeds: Record<string, RawFeedEntry>;
  reporters: Record<string, RawReporterEntry>;
};

type RawOracleReportersJson = Record<string, RawChainEntry | undefined>;

const ROOT = oracleReportersJson as RawOracleReportersJson;
const REPORTER_TYPE_SET = new Set<string>(ORACLE_REPORTER_TYPES);

function chainEntry(chainId: number): RawChainEntry | undefined {
  return ROOT[String(chainId)];
}

function isReporterType(
  value: string | undefined,
): value is OracleReporterType {
  return value !== undefined && REPORTER_TYPE_SET.has(value);
}

export function makeRateFeedId(
  chainId: number | bigint,
  feedAddress: string,
): string {
  return `${chainId}-${asAddress(feedAddress)}`;
}

export function getRateFeedPair(
  chainId: number,
  feedAddress: string,
): string | null {
  return chainEntry(chainId)?.feeds?.[asAddress(feedAddress)]?.pair ?? null;
}

export function getOracleReporterType(
  chainId: number,
  reporterAddress: string,
): OracleReporterType {
  const raw =
    chainEntry(chainId)?.reporters?.[asAddress(reporterAddress)]?.type;
  return isReporterType(raw) ? raw : "MANUAL";
}

export function normalizeReporters(reporters: ReadonlyArray<string>): string[] {
  return Array.from(new Set(reporters.map(asAddress)));
}

export function buildRateFeedEntity(args: {
  chainId: number;
  feedAddress: string;
  reporters: ReadonlyArray<string>;
  reportersComplete: boolean;
  blockNumber: bigint;
  blockTimestamp: bigint;
}): RateFeed {
  const feedAddress = asAddress(args.feedAddress);
  const reporters = normalizeReporters(args.reporters);
  return {
    id: makeRateFeedId(args.chainId, feedAddress),
    chainId: args.chainId,
    feedAddress,
    pair: getRateFeedPair(args.chainId, feedAddress) ?? "Unknown",
    reporters,
    reporterTypes: reporters.map((reporter) =>
      getOracleReporterType(args.chainId, reporter),
    ),
    reportersComplete: args.reportersComplete,
    updatedAtBlock: args.blockNumber,
    updatedAtTimestamp: args.blockTimestamp,
  };
}
