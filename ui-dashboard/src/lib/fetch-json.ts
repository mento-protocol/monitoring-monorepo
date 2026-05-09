/**
 * Shared fetcher for SWR hooks talking to our own `/api/*` routes.
 *
 * The contract: routes either return JSON (any status) or fail outright.
 * Non-2xx responses with `{ error: "..." }` get re-thrown with that message
 * so SWR's `error` field surfaces something the user can read.
 */

/** Default per-request deadline. SWR polling hooks revalidate on cadences
 *  starting at 30s, and the polling-Hasura PR checklist requires a
 *  deadline below the refresh interval — otherwise a wedged route can
 *  stall the loop and keep the request alive past the next refresh tick.
 *  Callers can override per-call via `opts.timeoutMs`. */
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
