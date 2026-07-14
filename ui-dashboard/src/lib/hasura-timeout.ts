/**
 * Per-request timeout (ms) for fail-open Hasura queries — OG card paths,
 * isolated EXT queries, anywhere a wedged HTTP connection should fail
 * fast and let the next refresh interval retry.
 *
 * Lives in its own zero-dependency module so server-side modules
 * (`homepage-og.ts`, `pool-og.ts`, `bridge-flows-og.ts`, the
 * `app/.../opengraph-image.tsx` paths) can import it without dragging
 * `useSWR` / `useNetwork` into the server bundle. Importing from
 * `lib/graphql.ts` (which exports the `useGQL` hook) is fine on the
 * client but breaks RSC bundling on the server.
 *
 * 5s mirrors what the Vercel OG renderer budgets for upstream data.
 * Pages requiring authoritative data shouldn't set a timeout — SWR's
 * retry/dedup is the right fallback there.
 */
export const HASURA_TIMEOUT_MS = 5000;

/**
 * Revalidation timeout (ms) for the `POOL_BREAKER_CONFIG` client SWR fetch.
 *
 * That query is safety-critical: `<BreakerPanel />` + `<MarketHoursPill />`
 * paint the SSR fallback (halted / market-hours state) on first paint and rely
 * on the client revalidation to confirm it. Passing only `fallbackData` leaves
 * the fetch UNBOUNDED — `useGQL` only attaches an `AbortSignal` when `timeoutMs`
 * is set (see graphql.ts `requestGQL`) — so a STALLED mount revalidation (never
 * resolves or rejects) would keep the stale snapshot on screen forever with
 * `error` never set, and the stale-refresh notice (which keys on `error`) would
 * never fire. A timeout turns a stall into an SWR error, engaging the
 * stale-refresh disclosure + SWR retry (issue #1257).
 *
 * 15s (half the 30s poll): the exception to the "authoritative data shouldn't
 * set a timeout" rule above, because for this query a silent stall is worse
 * than a bounded retry. Not the 5s OG budget — too aggressive for a client
 * safety query, it would spuriously error on slow-but-working fetches. Must be
 * < the 30s poll so a stall surfaces before the next poll. EVERY subscriber
 * that can own the deduplicated fetch (BreakerPanel, MarketHoursPill, the
 * oracle tab) must pass it, or SWR could run an unbounded fetcher from the one
 * that omits it.
 */
export const BREAKER_CONFIG_TIMEOUT_MS = 15_000;
