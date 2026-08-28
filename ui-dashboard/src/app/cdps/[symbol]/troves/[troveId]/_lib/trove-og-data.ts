// Server-only by convention. This module is reached from the route's
// opengraph-image and kept free of client hooks.
import { unstable_cache } from "next/cache";
import { cdpSymbolSlug } from "@/app/cdps/_lib/format";
import { HASURA_TIMEOUT_MS } from "@/lib/hasura-timeout";
import { makeOgGraphQLClient } from "@/lib/og-graphql-client";
import { NETWORKS } from "@/lib/networks";
import { CDP_TROVE_OG_BY_ID, CDP_TROVE_OG_COLLATERALS } from "@/lib/queries";
import type {
  CdpTroveOgByIdQuery,
  CdpTroveOgCollateralsQuery,
} from "@/lib/__generated__/graphql";
import {
  isValidTroveIdParam,
  makeTroveEntityId,
  normalizeTroveIdParam,
} from "./params";
import { formatBpsPercent } from "./format";
import { troveStatusLabel } from "./status";

const CELO = NETWORKS["celo-mainnet"];
const CACHE_REVALIDATE_SECONDS = 60;
export const TROVE_OG_MAX_DATA_AGE_MS = 5 * 60 * 1_000;

export type TroveOgTone =
  | "healthy"
  | "warning"
  | "critical"
  | "info"
  | "neutral";

export type TroveOgData = {
  symbol: string;
  troveId: string;
  status: string;
  statusLabel: string;
  statusTone: TroveOgTone;
  collateral: string;
  debt: string;
  icr: string;
  openedDate: string;
  lastEventLabel: "Closed" | "Last indexed";
  lastEventDate: string;
  fetchedAtMs: number;
};

type OgCollateral = CdpTroveOgCollateralsQuery["LiquityCollateral"][number];
type OgTrove = CdpTroveOgByIdQuery["Trove"][number];

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function canonicalParams(
  rawSymbol: string,
  rawTroveId: string,
): { symbol: string; troveId: string } | null {
  const decodedTroveId = decodeParam(rawTroveId);
  if (!isValidTroveIdParam(decodedTroveId)) return null;
  return {
    symbol: cdpSymbolSlug(decodeParam(rawSymbol)),
    troveId: normalizeTroveIdParam(decodedTroveId),
  };
}

function isIntegerString(value: string): boolean {
  return /^-?\d+$/.test(value);
}

function isValidTokenAmount(value: string): boolean {
  if (!isIntegerString(value)) return false;
  const amount = BigInt(value);
  return (
    (amount === BigInt(-1) || amount >= BigInt(0)) &&
    Number.isFinite(Number(value))
  );
}

function isValidTimestamp(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  const seconds = Number(value);
  return (
    Number.isSafeInteger(seconds) &&
    seconds > 0 &&
    !Number.isNaN(new Date(seconds * 1_000).getTime())
  );
}

function hasValidCollateralValues(collateral: OgCollateral): boolean {
  return (
    typeof collateral.id === "string" &&
    collateral.id !== "" &&
    collateral.chainId === CELO.chainId &&
    typeof collateral.symbol === "string" &&
    collateral.symbol !== "" &&
    Number.isInteger(collateral.mcrBps) &&
    collateral.mcrBps > 0
  );
}

function hasValidTroveValues(trove: OgTrove): boolean {
  return (
    typeof trove.id === "string" &&
    typeof trove.troveId === "string" &&
    typeof trove.status === "string" &&
    trove.status !== "" &&
    isValidTokenAmount(trove.debt) &&
    isValidTokenAmount(trove.coll) &&
    Number.isInteger(trove.icrBps) &&
    isValidTimestamp(trove.openedAt) &&
    isValidTimestamp(trove.lastUpdatedAt) &&
    (trove.closedAt === null || isValidTimestamp(trove.closedAt))
  );
}

function compactNumber(value: number): string {
  if (value >= 1_000_000_000)
    return `${(value / 1_000_000_000).toFixed(2).replace(/\.0+$|(?<=\.[0-9])0$/, "")}B`;
  if (value >= 1_000_000)
    return `${(value / 1_000_000).toFixed(2).replace(/\.0+$|(?<=\.[0-9])0$/, "")}M`;
  if (value >= 1_000)
    return `${(value / 1_000).toFixed(2).replace(/\.0+$|(?<=\.[0-9])0$/, "")}K`;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatOgTokenAmount(value: string, symbol: string): string {
  if (BigInt(value) === BigInt(-1)) return "—";
  return `${compactNumber(Number(value) / 10 ** 18)} ${symbol}`;
}

function utcDate(timestamp: string): string {
  const date = new Date(Number(timestamp) * 1_000);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().slice(0, 10);
}

function statusTone(status: string): TroveOgTone {
  if (status === "active") return "healthy";
  if (status === "zombie") return "warning";
  if (status === "liquidated") return "critical";
  if (status === "redeemed") return "info";
  return "neutral";
}

function buildTroveOgData(
  collateral: OgCollateral,
  trove: OgTrove,
  fetchedAtMs: number,
): TroveOgData | null {
  if (!hasValidCollateralValues(collateral) || !hasValidTroveValues(trove))
    return null;
  const closedAt = trove.closedAt;
  return {
    symbol: collateral.symbol,
    troveId: trove.troveId,
    status: trove.status,
    statusLabel: troveStatusLabel(trove.status),
    statusTone: statusTone(trove.status),
    collateral: formatOgTokenAmount(trove.coll, "USDm"),
    debt: formatOgTokenAmount(trove.debt, collateral.symbol),
    icr: formatBpsPercent(trove.icrBps),
    openedDate: utcDate(trove.openedAt),
    lastEventLabel: closedAt === null ? "Last indexed" : "Closed",
    lastEventDate: utcDate(closedAt ?? trove.lastUpdatedAt),
    fetchedAtMs,
  };
}

/** @internal Exported for focused data-contract tests. */
async function fetchTroveOgData(
  rawSymbol: string,
  rawTroveId: string,
): Promise<TroveOgData | null> {
  const params = canonicalParams(rawSymbol, rawTroveId);
  if (params === null || CELO.hasuraUrl === "") return null;
  const client = makeOgGraphQLClient(CELO);
  // Both sequential reads share one upstream budget. A slow collateral lookup
  // must not leave a fresh timeout window for the exact-trove lookup.
  const signal = AbortSignal.timeout(HASURA_TIMEOUT_MS);
  const collaterals = await client.request<CdpTroveOgCollateralsQuery>({
    document: CDP_TROVE_OG_COLLATERALS,
    variables: { chainId: CELO.chainId },
    signal,
  });
  const collateral = (collaterals.LiquityCollateral ?? []).find(
    (row) => cdpSymbolSlug(row.symbol) === params.symbol,
  );
  if (collateral === undefined) return null;
  const result = await client.request<CdpTroveOgByIdQuery>({
    document: CDP_TROVE_OG_BY_ID,
    variables: {
      troveEntityId: makeTroveEntityId(collateral.id, params.troveId),
    },
    signal,
  });
  const trove = result.Trove?.[0];
  return trove === undefined
    ? null
    : buildTroveOgData(collateral, trove, Date.now());
}

/** @internal Exported for focused data-contract tests. */
export async function fetchTroveOgDataUncached(
  rawSymbol: string,
  rawTroveId: string,
): Promise<TroveOgData | null> {
  try {
    return await fetchTroveOgData(rawSymbol, rawTroveId);
  } catch {
    return null;
  }
}

export function troveOgDataIsFresh(
  data: TroveOgData,
  nowMs: number = Date.now(),
): boolean {
  const ageMs = nowMs - data.fetchedAtMs;
  return ageMs >= 0 && ageMs <= TROVE_OG_MAX_DATA_AGE_MS;
}

const inFlightFetches = new Map<string, Promise<TroveOgData | null>>();

async function fetchTroveOgDataForCache(
  symbol: string,
  troveId: string,
): Promise<TroveOgData | null> {
  const key = `${symbol}:${troveId}`;
  const existing = inFlightFetches.get(key);
  if (existing !== undefined) return existing;

  const request = fetchTroveOgData(symbol, troveId).finally(() => {
    inFlightFetches.delete(key);
  });
  inFlightFetches.set(key, request);
  return request;
}

const cachedFetch = unstable_cache(
  fetchTroveOgDataForCache,
  [
    "trove-og",
    process.env.VERCEL_DEPLOYMENT_ID ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      "dev",
    `${CELO.id}=${CELO.hasuraUrl}`,
  ],
  { revalidate: CACHE_REVALIDATE_SECONDS, tags: ["trove-og"] },
);

export async function fetchTroveOgDataForMetadata(
  rawSymbol: string,
  rawTroveId: string,
): Promise<TroveOgData | null> {
  const params = canonicalParams(rawSymbol, rawTroveId);
  if (params === null) return null;
  try {
    const data = await cachedFetch(params.symbol, params.troveId);
    return data !== null && troveOgDataIsFresh(data) ? data : null;
  } catch {
    // Keep transport errors outside unstable_cache. Next can retain the last
    // good value when a revalidation fails, while the image still fails open.
    return null;
  }
}
