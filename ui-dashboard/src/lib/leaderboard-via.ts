import { ENVIO_MAX_ROWS } from "@/lib/constants";
import type { BrokerTraderRouterMarkerRow } from "@/lib/leaderboard";
import { BROKER_TRADER_ROUTER_DAY_MARKERS } from "@/lib/queries/leaderboard-via";

type BrokerViaMarkerPage = {
  BrokerTraderRouterDayMarker: BrokerTraderRouterMarkerRow[];
};

type BrokerViaMarkerRequester = {
  request<T>(args: {
    document: string;
    variables: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<T>;
};

export type BrokerViaMarkerPageResult = {
  rows: BrokerTraderRouterMarkerRow[];
  truncated: boolean;
};

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CALLER_CHUNK_SIZE = 10;
const DEFAULT_CONCURRENCY = 8;

/**
 * Fetch BrokerTraderRouterDayMarker rows for the visible top-N traders.
 *
 * Server-side filter is `caller _in [...]` + `timestamp _gte cutoff`; the
 * matching `@index` entries on the entity make this much cheaper than the
 * earlier id-cartesian shape (which exploded to ~120k ids for a 50-trader,
 * 30-day window across ~80 known tx.to addresses). Callers are chunked so a
 * single trader's marker volume can't blow the Hasura 1000-row response cap.
 * A chunk that returns exactly `ENVIO_MAX_ROWS` rows is treated as truncated
 * — top-50 / 30d analysis shows a worst case of ~780 markers/trader, so a
 * chunk of 10 traders is safely under cap in practice.
 */
export async function fetchBrokerTraderRouterMarkers(
  client: BrokerViaMarkerRequester,
  callers: readonly string[],
  cutoff: number,
  options: {
    chunkSize?: number;
    concurrency?: number;
    timeoutMs?: number;
  } = {},
): Promise<BrokerViaMarkerPageResult> {
  const callerChunkSize = Math.max(
    1,
    options.chunkSize ?? DEFAULT_CALLER_CHUNK_SIZE,
  );
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const uniqueCallers = [
    ...new Set(callers.map((caller) => caller.toLowerCase())),
  ];
  if (uniqueCallers.length === 0 || cutoff <= 0) {
    return { rows: [], truncated: false };
  }

  const rows: BrokerTraderRouterMarkerRow[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const signal = AbortSignal.timeout(timeoutMs);

  const chunks: string[][] = [];
  for (let index = 0; index < uniqueCallers.length; index += callerChunkSize) {
    chunks.push(uniqueCallers.slice(index, index + callerChunkSize));
  }

  for (let start = 0; start < chunks.length; start += concurrency) {
    const batch = chunks.slice(start, start + concurrency);
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const results = await Promise.all(
      batch.map((callerChunk) =>
        client.request<BrokerViaMarkerPage>({
          document: BROKER_TRADER_ROUTER_DAY_MARKERS,
          variables: {
            callers: callerChunk,
            afterTimestamp: cutoff,
            limit: ENVIO_MAX_ROWS,
          },
          signal,
        }),
      ),
    );
    for (const result of results) {
      const page = result.BrokerTraderRouterDayMarker;
      if (page.length === ENVIO_MAX_ROWS) truncated = true;
      for (const row of page) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
      }
    }
  }

  return { rows, truncated };
}
