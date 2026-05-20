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

/**
 * Like `fetchJsonOrThrow`, but resolves to `null` on a 404 instead of
 * throwing. Use for SWR hooks where the absence of a record is a
 * legitimate "nothing to render" state, not an error — e.g. the Arkham
 * detail panels where most addresses simply have no enriched data.
 *
 * Other non-2xx responses still throw so SWR can surface the message.
 */
export async function fetchJsonOr404<T>(
  url: string,
  label: string,
  opts: { timeoutMs?: number } = {},
): Promise<T | null> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `${label} failed (HTTP ${res.status})`);
  }
  return (await res.json()) as T;
}
