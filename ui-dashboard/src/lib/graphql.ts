import { GraphQLClient } from "graphql-request";
import useSWR, { type SWRResponse } from "swr";
import type { ZodType } from "zod";
import { useNetwork } from "@/components/network-provider";
import { rateLimitAwareRetry } from "@/lib/gql-retry";
import { GraphQLSchemaError } from "@/lib/graphql-schema-error";
import { HASURA_TIMEOUT_MS } from "@/lib/hasura-timeout";
import type { Network } from "@/lib/networks";

// Re-export for backward compatibility — but new server-side imports
// should target `@/lib/hasura-timeout` directly to avoid pulling
// useSWR / useNetwork into the server bundle (codex P1 PR #372).
export { HASURA_TIMEOUT_MS };

// Re-export so callers that `import { GraphQLSchemaError } from "@/lib/graphql"`
// continue to work without a second import path.
export { GraphQLSchemaError };

// Cache clients per Hasura URL so we don't recreate on every render
const clientCache = new Map<string, GraphQLClient>();

function getClient(network: Network): GraphQLClient {
  const cached = clientCache.get(network.hasuraUrl);
  if (cached) return cached;
  const client = new GraphQLClient(network.hasuraUrl);
  clientCache.set(network.hasuraUrl, client);
  return client;
}

// Pool-level data (oracle, reserves, health) doesn't move fast enough to
// justify a shorter interval, and a single pool page fans out ~15–20 parallel
// useGQL calls — at 10s we were burning the Envio "small" tier monthly quota
// and hitting 429 "Tier Quota" errors mid-session.
const DEFAULT_REFRESH_MS = 30_000;

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
 */
export function useGQL<T>(
  query: string | null,
  variables?: Record<string, unknown>,
  refreshInterval: number = DEFAULT_REFRESH_MS,
  /** Escape hatch for callers that need to override the defaults (e.g.
   *  re-enable focus revalidation for a one-shot read). Focus/reconnect
   *  revalidation is OFF by default for this hook — pool pages fan out
   *  ~15–20 parallel useGQL calls and every alt-tab would otherwise fire
   *  that many requests at once on top of the 30s polling cycle.
   *
   *  `timeoutMs` attaches an `AbortSignal.timeout(...)` to the request.
   *  Useful for fail-open extension queries (trust flags, isolated
   *  rollups) where a wedged Hasura connection would otherwise stick the
   *  SWR poll until the underlying socket times out (minutes). Primary
   *  page queries should leave it unset — users care about that data,
   *  so SWR's retry/dedup is the right behavior, not auto-cancel. */
  swrOptions?: {
    revalidateOnFocus?: boolean;
    revalidateOnReconnect?: boolean;
    timeoutMs?: number;
    /** Optional Zod schema to validate the response. When provided,
     *  a parse failure throws `GraphQLSchemaError` via SWR's error path. */
    schema?: ZodType<T>;
  },
): SWRResponse<T> {
  const { network } = useNetwork();
  const client = getClient(network);

  // Split `timeoutMs` and `schema` (custom, fetcher-only) from genuine SWR
  // options before spreading. SWR ignores unknown properties but the partition
  // keeps the config object honest for any future config-validating SWR plugin.
  const { timeoutMs, schema, ...swrConfigOverrides } = swrOptions ?? {};

  async function fetcher(): Promise<T> {
    const raw = await (timeoutMs == null
      ? client.request<T>(query!, variables)
      : client.request<T>({
          document: query!,
          variables,
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
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      onErrorRetry: rateLimitAwareRetry,
      ...swrConfigOverrides,
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
