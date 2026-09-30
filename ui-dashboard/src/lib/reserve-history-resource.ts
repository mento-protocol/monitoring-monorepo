import {
  fetchPoolReserveHistory,
  type ReserveHistory,
  type ReserveHistoryRange,
} from "@/lib/pool-reserve-history";

export function createReserveHistoryResource(
  endpoint: string,
  poolId: string,
  range: ReserveHistoryRange,
) {
  let previous: ReserveHistory | undefined;
  let controller: AbortController | undefined;
  let consumers = 0;
  return {
    async fetch() {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      const result = await fetchPoolReserveHistory(endpoint, poolId, range, {
        previous,
        signal: current.signal,
      });
      current.signal.throwIfAborted();
      previous = result;
      return result;
    },
    retain() {
      consumers++;
      return () => {
        consumers--;
        // Strict Mode re-attaches effects before this microtask runs.
        queueMicrotask(() => {
          if (consumers === 0) controller?.abort();
        });
      };
    },
  };
}
