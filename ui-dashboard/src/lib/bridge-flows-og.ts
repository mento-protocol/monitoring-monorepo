import { unstable_cache } from "next/cache";
import { GraphQLClient } from "graphql-request";
import { NETWORKS, NETWORK_IDS, type Network } from "@/lib/networks";
import { buildOracleRateMap, type OracleRateMap } from "@/lib/tokens";
import { ALL_POOLS_WITH_HEALTH } from "@/lib/queries";
import { BRIDGE_DAILY_SNAPSHOT } from "@/lib/bridge-queries";
import {
  buildVolumeUsdSeries,
  snapshotUsdValue,
  weekOverWeekChange,
  windowTotals,
} from "@/lib/bridge-flows/snapshots";
import { SECONDS_PER_DAY } from "@/lib/time-series";
import type { BridgeDailySnapshot, Pool } from "@/lib/types";

const THIRTY_DAYS = 30 * SECONDS_PER_DAY;

export type BridgeFlowsOgData = {
  /** Total bridged USD volume over the last 30 days (floored to UTC day).
   * `null` only when snapshots query failed entirely — `0` means genuinely
   * no bridge activity in the window. */
  volume30dUsd: number | null;
  /** Week-over-week change on the daily USD series (current 7d vs prior 7d).
   * Null when either week is empty or the baseline is 0. */
  volumeWoWPct: number | null;
  /** Chronological daily USD volume, oldest→newest, last 30 days. Empty
   * array when snapshots are unavailable — chart renderer skips it. */
  volumeSeries: number[];
  /** Count of bridge transfers initiated in the last 30 days. `null` when
   * snapshots are unavailable. */
  totalTransfers30d: number | null;
  /** Human labels for the chains bridged (e.g. ["Celo", "Monad"]). Drawn
   * directly from `NETWORKS[id].label` for the mainnet chains that share
   * the bridge Hasura URL. Never empty on prod. */
  chains: string[];
};

function makeClient(network: Network): GraphQLClient {
  const secret = network.hasuraSecret.trim();
  return new GraphQLClient(network.hasuraUrl, {
    headers: secret ? { "x-hasura-admin-secret": secret } : {},
  });
}

/**
 * Configured bridge-eligible chains. Bridge data lives on the single
 * multichain Hasura endpoint (shared between Celo + Monad mainnet entries
 * in NETWORKS), so we pick any one of them to source the snapshot query.
 * All configured mainnet chains contribute their oracle rates for pricing
 * rows that don't carry a pinned `sentUsdValue`.
 */
function bridgeChains(): Network[] {
  return NETWORK_IDS.map((id) => NETWORKS[id]).filter(
    (n) => n.hasuraUrl && !n.local && !n.testnet,
  );
}

/** @internal Exported for testing — skips the cache wrapper. */
export async function fetchBridgeFlowsOgDataUncached(): Promise<BridgeFlowsOgData | null> {
  const chains = bridgeChains();
  if (chains.length === 0) return null;

  // Per-request timeout. Without this a hung upstream would block the OG
  // route until Vercel's function timeout fires, stalling crawler unfurls.
  const signal = AbortSignal.timeout(5000);

  // Snapshots live on the multichain endpoint; any configured mainnet
  // network works as the query host (same env var backs both).
  const snapshotClient = makeClient(chains[0]!);
  const snapshotsPromise = snapshotClient.request<{
    BridgeDailySnapshot: BridgeDailySnapshot[];
  }>({
    document: BRIDGE_DAILY_SNAPSHOT,
    variables: { afterDate: 0 },
    signal,
  });

  // Oracle rate maps per chain — needed to price rows where `sentUsdValue`
  // is null. Fail-open: if the pool query for a chain errors, that chain
  // simply doesn't contribute rates; USDm/EURm/GBPm cross-chain prices
  // resolve from whichever chain is still reachable.
  const poolsPromises = chains.map((network) =>
    makeClient(network)
      .request<{ Pool: Pool[] }>({
        document: ALL_POOLS_WITH_HEALTH,
        variables: { chainId: network.chainId },
        signal,
      })
      .then((res) => ({ network, pools: res.Pool ?? [] })),
  );

  const [snapshotsResult, ...poolsResults] = await Promise.allSettled([
    snapshotsPromise,
    ...poolsPromises,
  ]);

  // Merge rate maps across all successfully-fetched chains. "First hit wins"
  // matches the page's client-side merge at bridge-flows/page.tsx:107-115, so
  // the OG prices rows identically to what the page displays.
  const rates: OracleRateMap = new Map();
  for (const result of poolsResults) {
    if (result.status !== "fulfilled") continue;
    const { network, pools } = result.value;
    for (const [k, v] of buildOracleRateMap(pools, network).entries()) {
      if (!rates.has(k)) rates.set(k, v);
    }
  }

  // If the snapshots query itself failed, fall back to a minimal card. The
  // chains list is still populated from config so the header badge renders.
  if (snapshotsResult.status !== "fulfilled") {
    return {
      volume30dUsd: null,
      volumeWoWPct: null,
      volumeSeries: [],
      totalTransfers30d: null,
      chains: chains.map((n) => n.label),
    };
  }

  const snapshots = snapshotsResult.value.BridgeDailySnapshot ?? [];

  const usdTotals = windowTotals(snapshots, (s) => snapshotUsdValue(s, rates));
  const countTotals = windowTotals(snapshots, (s) => s.sentCount ?? 0);
  const fullSeries = buildVolumeUsdSeries(snapshots, rates);

  // 30d window for the chart, aligned to UTC midnight (matches the page's
  // chart + KPI cutoff math in windowTotals).
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff30d =
    nowSec - THIRTY_DAYS - ((nowSec - THIRTY_DAYS) % SECONDS_PER_DAY);
  const volumeSeries = fullSeries
    .filter((p) => p.timestamp >= cutoff30d)
    .map((p) => p.value);

  // Distinguish "snapshots succeeded but empty" (truly idle bridge → 0) from
  // "snapshots query failed" (handled above with null). The query-failed
  // path returned `null` already; reaching this point means the response
  // came back, even if with zero rows. Return 0 in that case so the OG
  // says "30d volume $0" + "0 transfers" instead of falling through to the
  // generic unavailability fallback.
  return {
    volume30dUsd: snapshots.length === 0 ? 0 : usdTotals.sub30d,
    volumeWoWPct: weekOverWeekChange(fullSeries, nowSec),
    volumeSeries,
    totalTransfers30d: snapshots.length === 0 ? 0 : countTotals.sub30d,
    chains: chains.map((n) => n.label),
  };
}

const cachedFetch = unstable_cache(
  fetchBridgeFlowsOgDataUncached,
  ["bridge-flows-og"],
  { revalidate: 60, tags: ["bridge-flows-og"] },
);

export function fetchBridgeFlowsOgData(): Promise<BridgeFlowsOgData | null> {
  return cachedFetch();
}
