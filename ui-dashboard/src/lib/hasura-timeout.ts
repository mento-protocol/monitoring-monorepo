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
