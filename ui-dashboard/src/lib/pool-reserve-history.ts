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
const MAX_ROWS = PAGE_SIZE * MAX_PAGES;
const FETCH_BUDGET_MS = 20_000;
const RECONCILE_SECONDS = 3600;

export type ReserveHistory = {
  rows: ReserveHistoryRow[];
  from: number;
  to: number;
  truncated: boolean;
  reconciledAt?: number;
};

function refreshBaseline(previous: ReserveHistory | undefined, to: number) {
  return previous?.reconciledAt !== undefined &&
    previous.to <= to &&
    to - previous.reconciledAt < RECONCILE_SECONDS
    ? previous
    : undefined;
}

function retainedRows(
  previous: ReserveHistory | undefined,
  from: number,
  afterBlock: string,
) {
  const rows = new Map<string, ReserveHistoryRow>();
  for (const row of previous?.rows ?? []) {
    if (
      Number(row.blockTimestamp) >= from &&
      BigInt(row.blockNumber) <= BigInt(afterBlock)
    )
      rows.set(row.id, row);
  }
  return rows;
}

// Event ids end in the log index. Sort same-block events by that numeric
// index after cursor pagination, so log 10 does not plot before log 2.
function compareEvents(a: ReserveHistoryRow, b: ReserveHistoryRow): number {
  const blockDifference = BigInt(a.blockNumber) - BigInt(b.blockNumber);
  if (blockDifference !== BigInt(0))
    return blockDifference > BigInt(0) ? 1 : -1;
  return Number(a.id.split("_").at(-1)) - Number(b.id.split("_").at(-1));
}

async function requestPage(
  client: GraphQLClient,
  variables: Record<string, unknown>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<PoolReserveHistoryQuery> {
  parentSignal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("Reserve history request timed out.")),
    timeoutMs,
  );
  try {
    return await client.request<PoolReserveHistoryQuery>({
      document: POOL_RESERVE_HISTORY,
      variables,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
  }
}

export async function fetchPoolReserveHistory(
  endpoint: string,
  poolId: string,
  range: ReserveHistoryRange,
  options: { previous?: ReserveHistory | undefined; signal?: AbortSignal } = {},
): Promise<ReserveHistory> {
  const client = new GraphQLClient(endpoint);
  const to = Math.floor(Date.now() / 1000);
  const from = range === "All" ? 0 : to - RANGE_SECONDS[range];
  const deadline = Date.now() + FETCH_BUDGET_MS;
  // Reconcile the full range hourly so deeper reorgs also remove orphaned rows.
  const previous = refreshBaseline(options.previous, to);
  // Replace the last block, including any rows deleted by a reorg.
  const lastBlock = previous?.rows.at(-1)?.blockNumber;
  let afterBlock = lastBlock ? String(BigInt(lastBlock) - BigInt(1)) : "-1";
  const rows = retainedRows(previous, from, afterBlock);
  let afterId = "";
  const result = (truncated: boolean): ReserveHistory => ({
    rows: sortedCopy([...rows.values()], compareEvents).slice(0, MAX_ROWS),
    from,
    to,
    truncated,
    reconciledAt: previous?.reconciledAt ?? to,
  });
  for (let page = 0; page < MAX_PAGES; page++) {
    options.signal?.throwIfAborted();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("Reserve history request timed out.");
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Each page needs the previous page's cursor.
    const data = await requestPage(
      client,
      { poolId, from, to, afterBlock, afterId, limit: PAGE_SIZE },
      Math.min(5000, remainingMs),
      options.signal,
    );
    options.signal?.throwIfAborted();
    const batch = data.ReserveUpdate;
    for (const row of batch) rows.set(row.id, row);
    if (rows.size >= MAX_ROWS) return result(true);
    if (batch.length < PAGE_SIZE) return result(false);
    const last = batch[batch.length - 1]!;
    if (last.blockNumber === afterBlock && last.id === afterId) {
      throw new Error("Reserve history pagination did not advance.");
    }
    afterBlock = last.blockNumber;
    afterId = last.id;
  }
  return result(true);
}
