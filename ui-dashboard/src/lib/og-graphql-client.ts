import { GraphQLClient } from "graphql-request";
import type { Network } from "@/lib/networks";

// Shared server-side GraphQLClient factory for OG metadata/image routes.
// Deliberately separate from `lib/graphql.ts`'s `getClient` which pulls in
// `useSWR` and `useNetwork` (client-only) and would poison the server
// bundle.
export function makeOgGraphQLClient(network: Network): GraphQLClient {
  const secret = network.hasuraSecret.trim();
  return new GraphQLClient(network.hasuraUrl, {
    headers: secret ? { "x-hasura-admin-secret": secret } : {},
  });
}
