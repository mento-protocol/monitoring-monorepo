import oracleReportersJson from "../oracle-reporters.json" with { type: "json" };

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
  name?: string;
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

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

function isReporterType(
  value: string | undefined,
): value is OracleReporterType {
  return value !== undefined && REPORTER_TYPE_SET.has(value);
}

export function getRateFeedPair(
  chainId: number,
  feedAddress: string,
): string | null {
  return (
    chainEntry(chainId)?.feeds?.[normalizeAddress(feedAddress)]?.pair ?? null
  );
}

export function getOracleReporterType(
  chainId: number,
  reporterAddress: string,
): OracleReporterType {
  const raw =
    chainEntry(chainId)?.reporters?.[normalizeAddress(reporterAddress)]?.type;
  return isReporterType(raw) ? raw : "MANUAL";
}

export function describeRateFeed(
  chainId: number,
  feedAddress: string,
  reporters: ReadonlyArray<string>,
): {
  pair: string;
  reporterTypes: OracleReporterType[];
} {
  return {
    pair: getRateFeedPair(chainId, feedAddress) ?? "Unknown",
    reporterTypes: reporters.map((reporter) =>
      getOracleReporterType(chainId, reporter),
    ),
  };
}

export function knownRateFeedsByChain(
  chainId: number,
): ReadonlyMap<string, string> {
  const feeds = chainEntry(chainId)?.feeds;
  if (!feeds) {
    return new Map();
  }
  return new Map(
    Object.entries(feeds).map(([address, entry]) => [
      normalizeAddress(address),
      entry.pair,
    ]),
  );
}
