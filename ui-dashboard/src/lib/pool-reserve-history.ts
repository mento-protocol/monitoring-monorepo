import type { PoolReserveHistoryQuery } from "@/lib/__generated__/graphql";
import { GraphQLClient } from "@/lib/graphql-fetch";
import { POOL_RESERVE_HISTORY } from "@/lib/queries";
import { sortedCopy } from "@/lib/immutable-sort";

export const RESERVE_HISTORY_RANGES = ["1h", "6h", "1d", "7d", "All"] as const;
export type ReserveHistoryRange = (typeof RESERVE_HISTORY_RANGES)[number];
type ReserveHistoryRow = PoolReserveHistoryQuery["ReserveUpdate"][number];

const RANGE_SECONDS = { "1h": 3600, "6h": 21600, "1d": 86400, "7d": 604800 };
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;
const FETCH_BUDGET_MS = 20_000;

export type ReserveHistory = {
  rows: ReserveHistoryRow[];
  from: number;
  to: number;
  truncated: boolean;
};

// Event ids end in the log index. Sort same-block events by that numeric
// index after cursor pagination, so log 10 does not plot before log 2.
function compareEvents(a: ReserveHistoryRow, b: ReserveHistoryRow): number {
  const blockDifference = BigInt(a.blockNumber) - BigInt(b.blockNumber);
  if (blockDifference !== BigInt(0))
    return blockDifference > BigInt(0) ? 1 : -1;
  return Number(a.id.split("_").at(-1)) - Number(b.id.split("_").at(-1));
}

export async function fetchPoolReserveHistory(
  endpoint: string,
  poolId: string,
  range: ReserveHistoryRange,
): Promise<ReserveHistory> {
  const client = new GraphQLClient(endpoint);
  const to = Math.floor(Date.now() / 1000);
  const from = range === "All" ? 0 : to - RANGE_SECONDS[range];
  const deadline = Date.now() + FETCH_BUDGET_MS;
  const rows: ReserveHistoryRow[] = [];
  let afterBlock = "-1";
  let afterId = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("Reserve history request timed out.");
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Each page needs the previous page's cursor.
    const data = await client.request<PoolReserveHistoryQuery>({
      document: POOL_RESERVE_HISTORY,
      variables: { poolId, from, to, afterBlock, afterId, limit: PAGE_SIZE },
      signal: AbortSignal.timeout(Math.min(5000, remainingMs)),
    });
    const batch = data.ReserveUpdate;
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) {
      return {
        rows: sortedCopy(rows, compareEvents),
        from,
        to,
        truncated: false,
      };
    }
    const last = batch[batch.length - 1]!;
    if (last.blockNumber === afterBlock && last.id === afterId) {
      throw new Error("Reserve history pagination did not advance.");
    }
    afterBlock = last.blockNumber;
    afterId = last.id;
  }
  return { rows: sortedCopy(rows, compareEvents), from, to, truncated: true };
}
