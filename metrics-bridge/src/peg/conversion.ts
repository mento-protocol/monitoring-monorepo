import { contractEntries } from "@mento-protocol/config/tokens";
import { createRequire } from "node:module";
import type { PublicClient } from "viem";
import { classifyFxMarketPause } from "../fx-market.js";
import type { PegConversion } from "./registry.js";

const SORTED_ORACLES_ABI = [
  {
    type: "function",
    name: "medianRate",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "", type: "uint256" },
      { name: "", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "medianTimestamp",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tokenReportExpirySeconds",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "reportExpirySeconds",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export const MAX_ORACLE_CLOCK_SKEW_SECONDS = 60;

type OracleReporterRegistry = Record<
  string,
  { feeds?: Record<string, { pair?: string }> }
>;

const require = createRequire(import.meta.url);
const oracleReporters =
  require("@mento-protocol/config/oracle-reporters.json") as OracleReporterRegistry;

export interface PegConversionLeg {
  rate: number;
  medianAt: number;
  expirySeconds: number;
  authoritative: boolean;
  unavailableReason: "stale" | "future_timestamp" | "fx_market_pause" | null;
}

export function conversionFeedPair(conversion: PegConversion): string {
  const chain = oracleReporters[String(conversion.chainId)];
  const pair = chain?.feeds?.[conversion.rateFeedId]?.pair;
  if (!pair) {
    throw new Error(
      `Unknown conversion feed ${conversion.rateFeedId} on chain ${conversion.chainId}`,
    );
  }
  const expected = `${conversion.toCurrency}/${conversion.fromCurrency}`;
  if (pair !== expected) {
    throw new Error(
      `Conversion feed ${pair} does not compose ${conversion.fromCurrency} into ${conversion.toCurrency}; expected ${expected}`,
    );
  }
  return pair;
}

export function sortedOraclesAddress(chainId: number): `0x${string}` {
  const entry = contractEntries(chainId).find(
    ({ rawName }) => rawName === "SortedOracles",
  );
  if (!entry) {
    throw new Error(`SortedOracles is not configured on chain ${chainId}`);
  }
  return entry.address as `0x${string}`;
}

function ratioToNumber(numerator: bigint, denominator: bigint): number {
  if (numerator <= 0n || denominator <= 0n) {
    throw new Error("SortedOracles median rate must be positive");
  }
  const precision = 10n ** 12n;
  const scaled = (numerator * precision) / denominator;
  const value = Number(scaled) / Number(precision);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("SortedOracles median rate is not representable");
  }
  return value;
}

function toSafeSeconds(value: bigint, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return number;
}

export async function readPegConversionLeg(
  conversion: PegConversion,
  client: PublicClient,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<PegConversionLeg> {
  const pair = conversionFeedPair(conversion);
  const address = sortedOraclesAddress(conversion.chainId);
  const feed = conversion.rateFeedId as `0x${string}`;
  const [medianRate, medianTimestamp, tokenExpiry] = await Promise.all([
    client.readContract({
      address,
      abi: SORTED_ORACLES_ABI,
      functionName: "medianRate",
      args: [feed],
    }),
    client.readContract({
      address,
      abi: SORTED_ORACLES_ABI,
      functionName: "medianTimestamp",
      args: [feed],
    }),
    client.readContract({
      address,
      abi: SORTED_ORACLES_ABI,
      functionName: "tokenReportExpirySeconds",
      args: [feed],
    }),
  ]);
  const [numerator, denominator] = medianRate;
  const medianAt = toSafeSeconds(medianTimestamp, "medianTimestamp");
  const expiryRaw =
    tokenExpiry > 0n
      ? tokenExpiry
      : await client.readContract({
          address,
          abi: SORTED_ORACLES_ABI,
          functionName: "reportExpirySeconds",
        });
  const expirySeconds = toSafeSeconds(expiryRaw, "reportExpirySeconds");
  const fxPause = classifyFxMarketPause(pair, nowSeconds);
  const ageSeconds = nowSeconds - medianAt;
  const futureTimestamp = ageSeconds < -MAX_ORACLE_CLOCK_SKEW_SECONDS;
  const stale = ageSeconds > expirySeconds;
  return {
    rate: ratioToNumber(numerator, denominator),
    medianAt,
    expirySeconds,
    authoritative: !stale && !futureTimestamp && fxPause === null,
    unavailableReason: stale
      ? "stale"
      : futureTimestamp
        ? "future_timestamp"
        : fxPause === null
          ? null
          : "fx_market_pause",
  };
}

/** Convert a venue price in Q into peg currency P via the P/Q feed. */
export function convertQuotePriceToPeg(
  quotePrice: number,
  conversion: PegConversionLeg,
): number {
  if (!Number.isFinite(quotePrice) || quotePrice <= 0) {
    throw new Error("Quote price must be finite and positive");
  }
  if (!conversion.authoritative) {
    throw new Error("Conversion leg is not alert-authoritative");
  }
  return quotePrice / conversion.rate;
}
