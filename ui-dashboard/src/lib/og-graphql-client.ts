import { GraphQLClient } from "graphql-request";
import type { Network } from "@/lib/networks";

// Shared server-side GraphQLClient factory for OG metadata/image routes.
// Deliberately separate from `lib/graphql.ts`'s `getClient` which pulls in
// `useSWR` and `useNetwork` (client-only) and would poison the server
// bundle. No admin-secret header: client `Network.hasuraSecret` is always
// empty by policy (see networks.ts), and local networks authenticate via
// the server-only `/api/hasura/[networkId]` proxy instead.
export function makeOgGraphQLClient(network: Network): GraphQLClient {
  return new GraphQLClient(network.hasuraUrl);
}
