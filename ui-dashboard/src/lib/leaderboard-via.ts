import { ENVIO_MAX_ROWS } from "@/lib/constants";
import type { BrokerAggregatorTraderDayMarkerRow } from "@/lib/leaderboard";
import { BROKER_AGGREGATOR_TRADER_DAY_MARKERS } from "@/lib/queries/leaderboard-via";

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
const DEFAULT_MAX_PAGES = 20;

export async function fetchBrokerViaMarkerPages(
  client: BrokerViaMarkerRequester,
  idRegex: string,
  options: {
    pageSize?: number;
    maxPages?: number;
    timeoutMs?: number;
  } = {},
): Promise<BrokerViaMarkerPageResult> {
  const pageSize = options.pageSize ?? ENVIO_MAX_ROWS;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const rows: BrokerAggregatorTraderDayMarkerRow[] = [];
  const seen = new Set<string>();
  const signal = AbortSignal.timeout(timeoutMs);
  let afterId = "";

  for (let page = 0; page < maxPages; page += 1) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const result = await client.request<BrokerViaMarkerPage>({
      document: BROKER_AGGREGATOR_TRADER_DAY_MARKERS,
      variables: { idRegex, afterId, limit: pageSize },
      signal,
    });
    const batch = result.BrokerAggregatorTraderDayMarker;
    for (const row of batch) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    if (batch.length < pageSize) {
      return { rows, truncated: false };
    }
    const nextAfterId = batch.at(-1)?.id;
    if (!nextAfterId || nextAfterId === afterId) {
      return { rows, truncated: true };
    }
    afterId = nextAfterId;
  }

  return { rows, truncated: true };
}
