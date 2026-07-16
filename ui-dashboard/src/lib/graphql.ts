import { useMemo } from "react";
import useSWR, { preload, type SWRResponse } from "swr";
import { cache, serialize, SWRGlobalState } from "swr/_internal";
import { useNetwork } from "@/components/network-provider";
import { rateLimitAwareRetry } from "@/lib/gql-retry";
import { resolveGraphqlEndpoint } from "@/lib/graphql-endpoint";
import { GraphQLClient } from "@/lib/graphql-fetch";
import { GraphQLSchemaError } from "@/lib/graphql-schema-error";
import { HASURA_TIMEOUT_MS } from "@/lib/hasura-timeout";
import type { Network } from "@/lib/networks";
import type { SafeParseSchema } from "@/lib/safe-parse-schema";

// Re-export for backward compatibility — but new server-side imports
// should target `@/lib/hasura-timeout` directly to avoid pulling
// useSWR / useNetwork into the server bundle (codex P1 PR #372).
export { HASURA_TIMEOUT_MS };

// Cache clients per Hasura URL so we don't recreate on every render.
const clientCache = new Map<string, GraphQLClient>();

function getClient(network: Network): GraphQLClient {
  const endpoint = resolveGraphqlEndpoint(network.hasuraUrl);
  const cached = clientCache.get(endpoint);
  if (cached !== undefined) return cached;
  const client = new GraphQLClient(endpoint);
  clientCache.set(endpoint, client);
  return client;
}

type GqlVariables = Record<string, unknown> | undefined;
type GqlKey = readonly [string, string, GqlVariables];
type PreloadTimer = ReturnType<typeof globalThis.setTimeout>;

const SPECULATIVE_PRELOAD_TTL_MS = 5_000;
const gqlPreloadTimers = new Map<string, PreloadTimer>();

function gqlKey(
  network: Network,
  query: string | null,
  variables: GqlVariables,
): GqlKey | null {
  return query && network.hasuraUrl ? [network.id, query, variables] : null;
}

async function requestGQL<T>(
  network: Network,
  query: string,
  variables: GqlVariables,
  opts: Pick<UseGQLOptions<T>, "schema" | "timeoutMs"> = {},
): Promise<T> {
  const client = getClient(network);
  const raw = await (opts.timeoutMs == null
    ? variables !== undefined
      ? client.request<T>(query, variables)
      : client.request<T>(query)
    : client.request<T>({
        document: query,
        ...(variables !== undefined ? { variables } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs),
      }));
  if (opts.schema != null) {
    const result = opts.schema.safeParse(raw);
    if (!result.success) {
      // Pass the operation name (not the full GQL document) as the hint
      // so Sentry titles stay readable.
      const hint = query.match(/\b(?:query|mutation)\s+(\w+)/)?.[1];
      throw new GraphQLSchemaError(result.error.issues, hint);
    }
    return result.data;
  }
  return raw;
}

export function preloadGQL<T>(
  network: Network,
  query: string,
  variables?: Record<string, unknown>,
  options: { ttlMs?: number; timeoutMs?: number } = {},
): void {
  const key = gqlKey(network, query, variables);
  if (!key) return;
  const [serializedKey] = serialize(key);
  if (!serializedKey) return;

  const req = preload(key, () =>
    requestGQL<T>(network, query, variables, {
      timeoutMs: options.timeoutMs,
    }),
  );
  if (req === undefined) return;

  const ttlMs = options.ttlMs ?? SPECULATIVE_PRELOAD_TTL_MS;
  clearGQLPreloadTimer(serializedKey);
  gqlPreloadTimers.set(
    serializedKey,
    globalThis.setTimeout(() => clearGQLPreload(serializedKey), ttlMs),
  );
  void Promise.resolve(req).catch(() => clearGQLPreload(serializedKey));
}

function clearGQLPreload(serializedKey: string): void {
  clearGQLPreloadTimer(serializedKey);
  const state = SWRGlobalState.get(cache);
  const preloads = state?.[3];
  if (preloads) {
    delete preloads[serializedKey];
  }
}

function clearGQLPreloadTimer(serializedKey: string): void {
  const timer = gqlPreloadTimers.get(serializedKey);
  if (timer == null) return;
  globalThis.clearTimeout(timer);
  gqlPreloadTimers.delete(serializedKey);
}

// Pool-level data (oracle, reserves, health) doesn't move fast enough to
// justify a shorter interval, and a single pool page fans out ~15–20 parallel
// useGQL calls — at 10s we were burning the Envio "small" tier monthly quota
// and hitting 429 "Tier Quota" errors mid-session.
const DEFAULT_REFRESH_MS = 30_000;

/** Options accepted by `useGQL` (also composable as the 3rd argument). */
export type UseGQLOptions<T> = {
  /** Override the default 30s polling interval. Can also be supplied as the
   *  positional 3rd argument for backward compatibility. */
  refreshInterval?: number | undefined;
  /** Escape hatch for callers that need to override the defaults (e.g.
   *  re-enable focus revalidation for a one-shot read). Focus/reconnect
   *  revalidation is OFF by default for this hook — pool pages fan out
   *  ~15–20 parallel useGQL calls and every alt-tab would otherwise fire
   *  that many requests at once on top of the 30s polling cycle. */
  revalidateOnFocus?: boolean | undefined;
  revalidateOnReconnect?: boolean | undefined;
  /** Attaches an `AbortSignal.timeout(...)` to the request. Useful for
   *  fail-open extension queries where a wedged Hasura connection would
   *  otherwise stick the SWR poll until the socket times out (minutes). */
  timeoutMs?: number | undefined;
  /** Optional Zod schema to validate the response. When provided,
   *  a parse failure throws `GraphQLSchemaError` via SWR's error path. */
  schema?: SafeParseSchema<T> | undefined;
  /** Server-prefetched initial data for SSR-prefetch pages. Forwarded to SWR's
   *  `fallbackData` at this hook's computed key, so the first client render paints
   *  real content instead of a skeleton (kills the layout shift) while the normal
   *  poll revalidates in the background. */
  fallbackData?: T | undefined;
  /** Retain the prior cache key's data while a new key loads. Opt-in because
   *  most callers poll a fixed key and should keep SWR's default semantics. */
  keepPreviousData?: boolean | undefined;
  /** Runs after each successful network response, including unchanged data.
   *  Used by freshness-sensitive consumers to record when a cached row was
   *  actually re-observed rather than aging it continuously in the browser. */
  onSuccess?: ((data: T) => void) | undefined;
};

/**
 * Network-aware GraphQL hook.
 * Automatically switches Hasura endpoint based on the current network context.
 * SWR cache keys include the network ID so data doesn't bleed across networks.
 *
 * When the network's Hasura URL is empty (unconfigured network),
 * the fetch is skipped and a descriptive error is returned immediately.
 *
 * Pass `schema` to validate the response at the fetch boundary. On parse
 * failure the hook throws `GraphQLSchemaError` (surfaced via SWR's error
 * path). Adoption is opt-in — callers that omit `schema` behave exactly as
 * before. This turns silent Hasura schema-drift bugs into typed errors caught
 * at fetch time rather than at render time as mysterious `undefined` values.
 *
 * The 3rd argument accepts either a `number` (refreshInterval, legacy form)
 * or a `UseGQLOptions` object (preferred form when only schema/timeoutMs are
 * needed and the default 30s interval is fine).
 */
export function useGQL<T>(
  query: string | null,
  variables?: Record<string, unknown>,
  refreshIntervalOrOptions?: number | UseGQLOptions<T>,
  legacyOptions?: Omit<UseGQLOptions<T>, "refreshInterval">,
): SWRResponse<T> {
  const { network } = useNetwork();

  // Normalise the two calling conventions:
  //   (q, v, number, opts?)  — legacy positional refreshInterval
  //   (q, v, opts)           — preferred object form (no undefined placeholder)
  const opts: UseGQLOptions<T> =
    typeof refreshIntervalOrOptions === "object" &&
    refreshIntervalOrOptions !== null
      ? refreshIntervalOrOptions
      : {
          refreshInterval: refreshIntervalOrOptions,
          ...legacyOptions,
        };
  // Default the SWR revalidation gates explicitly rather than spreading
  // `opts` into useSWR — UseGQLOptions widens those keys to `boolean |
  // undefined` under exactOptionalPropertyTypes, and SWR's typed config
  // rejects an explicit `undefined` for `revalidateOnFocus` /
  // `revalidateOnReconnect`.
  const {
    refreshInterval = DEFAULT_REFRESH_MS,
    timeoutMs,
    schema,
    revalidateOnFocus = false,
    revalidateOnReconnect = false,
    fallbackData,
    keepPreviousData,
    onSuccess,
  } = opts;

  async function fetcher(): Promise<T> {
    return requestGQL<T>(network, query!, variables, { schema, timeoutMs });
  }

  const swrKey = useMemo(
    () => gqlKey(network, query, variables),
    [network.id, network.hasuraUrl, query, variables],
  );
  const result = useSWR<T>(swrKey, fetcher, {
    refreshInterval,
    revalidateOnFocus,
    revalidateOnReconnect,
    refreshWhenHidden: false,
    onErrorRetry: rateLimitAwareRetry,
    ...(onSuccess !== undefined && { onSuccess }),
    ...(fallbackData !== undefined && { fallbackData }),
    ...(keepPreviousData !== undefined && { keepPreviousData }),
  });

  if (!network.hasuraUrl) {
    return {
      ...result,
      isLoading: false,
      error: new Error(
        `Hasura URL not configured for "${network.label}". ` +
          `Get the GraphQL endpoint from the Envio dashboard and set it in .env.local.`,
      ),
    } as SWRResponse<T>;
  }

  return result;
}
