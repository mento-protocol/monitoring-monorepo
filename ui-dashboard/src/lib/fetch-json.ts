/**
 * Shared fetcher for SWR hooks talking to our own `/api/*` routes.
 *
 * The contract: routes either return JSON (any status) or fail outright.
 * Non-2xx responses with `{ error: "..." }` get re-thrown with that message
 * so SWR's `error` field surfaces something the user can read.
 */

/** Default per-request deadline. Both polling hooks consuming this fetcher
 *  (use-v2-exchange-config + use-rebalance-check) revalidate every 60s, and
 *  the SWR-polling Hasura PR checklist requires a deadline below the
 *  refresh interval — otherwise a wedged route can stall the loop and keep
 *  the request alive past the next refresh tick. 30s is the same number we
 *  use for upstream RPC timeouts in v2-exchange-config (15s upstream + a
 *  bit of headroom for serialization). */
const DEFAULT_TIMEOUT_MS = 30_000;

export async function fetchJsonOrThrow<T>(
  url: string,
  label: string,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `${label} failed (HTTP ${res.status})`);
  }
  return (await res.json()) as T;
}
