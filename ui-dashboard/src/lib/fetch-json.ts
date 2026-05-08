/**
 * Shared fetcher for SWR hooks talking to our own `/api/*` routes.
 *
 * The contract: routes either return JSON (any status) or fail outright.
 * Non-2xx responses with `{ error: "..." }` get re-thrown with that message
 * so SWR's `error` field surfaces something the user can read.
 */
export async function fetchJsonOrThrow<T>(
  url: string,
  label: string,
): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `${label} failed (HTTP ${res.status})`);
  }
  return (await res.json()) as T;
}
