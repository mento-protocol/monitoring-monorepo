import { GraphQLClient } from "graphql-request";
import useSWR, { type SWRResponse } from "swr";
import type { ZodType } from "zod";
import { useNetwork } from "@/components/network-provider";
import { rateLimitAwareRetry } from "@/lib/gql-retry";
import { resolveGraphqlEndpoint } from "@/lib/graphql-endpoint";
import { GraphQLSchemaError } from "@/lib/graphql-schema-error";
import { HASURA_TIMEOUT_MS } from "@/lib/hasura-timeout";
import type { Network } from "@/lib/networks";

// Re-export for backward compatibility — but new server-side imports
// should target `@/lib/hasura-timeout` directly to avoid pulling
// useSWR / useNetwork into the server bundle (codex P1 PR #372).
export { HASURA_TIMEOUT_MS };

// Cache clients per Hasura URL so we don't recreate on every render
const clientCache = new Map<string, GraphQLClient>();

function getClient(network: Network): GraphQLClient {
  const endpoint = resolveGraphqlEndpoint(network.hasuraUrl);
  const cached = clientCache.get(endpoint);
  if (cached) return cached;
  const client = new GraphQLClient(endpoint);
  clientCache.set(endpoint, client);
  return client;
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
  schema?: ZodType<T> | undefined;
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
  const client = getClient(network);

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
  } = opts;

  async function fetcher(): Promise<T> {
    const raw = await (timeoutMs == null
      ? variables !== undefined
        ? client.request<T>(query!, variables)
        : client.request<T>(query!)
      : client.request<T>({
          document: query!,
          ...(variables !== undefined ? { variables } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        }));
    if (schema != null) {
      const result = schema.safeParse(raw);
      if (!result.success) {
        // Pass the operation name (not the full GQL document) as the hint
        // so Sentry titles stay readable.
        const hint = query?.match(/\b(?:query|mutation)\s+(\w+)/)?.[1];
        throw new GraphQLSchemaError(result.error.issues, hint);
      }
      return result.data;
    }
    return raw;
  }

  const result = useSWR<T>(
    query && network.hasuraUrl ? [network.id, query, variables] : null,
    fetcher,
    {
      refreshInterval,
      revalidateOnFocus,
      revalidateOnReconnect,
      refreshWhenHidden: false,
      onErrorRetry: rateLimitAwareRetry,
    },
  );

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
