import { ENVIO_MAX_ROWS } from "@/lib/constants";
import {
  BROKER_VIA_MARKER_ID_LIMIT,
  type BrokerAggregatorTraderDayMarkerRow,
} from "@/lib/leaderboard";
import { BROKER_AGGREGATOR_TRADER_DAY_MARKERS_BY_ID } from "@/lib/queries/leaderboard-via";

type BrokerViaMarkerPage = {
  BrokerAggregatorTraderDayMarker: BrokerAggregatorTraderDayMarkerRow[];
};

type BrokerViaMarkerRequester = {
  request<T>(args: {
    document: string;
    variables: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<T>;
};

export type BrokerViaMarkerPageResult = {
  rows: BrokerAggregatorTraderDayMarkerRow[];
  truncated: boolean;
};

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CHUNK_SIZE = ENVIO_MAX_ROWS;
const DEFAULT_MAX_IDS = BROKER_VIA_MARKER_ID_LIMIT;
const DEFAULT_CONCURRENCY = 8;

export async function fetchBrokerViaMarkerIds(
  client: BrokerViaMarkerRequester,
  markerIds: readonly string[],
  options: {
    chunkSize?: number;
    maxIds?: number;
    concurrency?: number;
    timeoutMs?: number;
  } = {},
): Promise<BrokerViaMarkerPageResult> {
  const chunkSize = Math.max(
    1,
    Math.min(options.chunkSize ?? DEFAULT_CHUNK_SIZE, ENVIO_MAX_ROWS),
  );
  const maxIds = options.maxIds ?? DEFAULT_MAX_IDS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ids = [...new Set(markerIds)];
  if (ids.length === 0) return { rows: [], truncated: false };
  if (ids.length > maxIds) return { rows: [], truncated: true };

  const rows: BrokerAggregatorTraderDayMarkerRow[] = [];
  const seen = new Set<string>();
  const signal = AbortSignal.timeout(timeoutMs);

  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += chunkSize) {
    chunks.push(ids.slice(index, index + chunkSize));
  }

  for (let start = 0; start < chunks.length; start += concurrency) {
    const batchChunks = chunks.slice(start, start + concurrency);
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const results = await Promise.all(
      batchChunks.map((idsChunk) =>
        client.request<BrokerViaMarkerPage>({
          document: BROKER_AGGREGATOR_TRADER_DAY_MARKERS_BY_ID,
          variables: { ids: idsChunk, limit: idsChunk.length },
          signal,
        }),
      ),
    );
    for (const result of results) {
      for (const row of result.BrokerAggregatorTraderDayMarker) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
      }
    }
  }

  return { rows, truncated: false };
}
