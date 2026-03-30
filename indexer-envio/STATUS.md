# Indexer Status

Last updated: 2026-03-30

## Current State

Single multichain indexer (Celo + Monad) live on Envio's hosted service.

| Network      | Envio Project | Plan             | Status  | Sync |
| ------------ | ------------- | ---------------- | ------- | ---- |
| Celo Mainnet | `mento`       | Production Small | ✅ Live | 100% |
| Monad        | `mento`       | Production Small | ✅ Live | 100% |

## GraphQL Endpoint

The multichain indexer uses a **static** production endpoint (hash does not change on redeploy):

```text
https://indexer.hyperindex.xyz/2f3dd15/v1/graphql
```

Stored as `NEXT_PUBLIC_HASURA_URL_MULTICHAIN_HOSTED` in Vercel project settings and as the `hasura_url_multichain_hosted` Terraform variable default.

> Only update these if the `mento` project is deleted and recreated (which would issue a new endpoint hash).
> Redeployments to the same project preserve the static endpoint.

## Pool ID Format

Pool IDs are namespaced as `{chainId}-{address}` (e.g. `42220-0x02fa...`, `143-0xd0e9...`).
All child entities (`poolId` FKs) follow the same format.

## Config File

`indexer-envio/config.multichain.mainnet.yaml` — covers both Celo (42220) and Monad (143).

Git release branch: `envio` — push to this branch to trigger a redeployment.

## Legacy Endpoints (kept as fallback, to be retired)

| Endpoint                                            | Project                  | Notes                                                 |
| --------------------------------------------------- | ------------------------ | ----------------------------------------------------- |
| `https://indexer.hyperindex.xyz/60ff18c/v1/graphql` | `mento-v3-celo-mainnet`  | Celo-only, old schema (no chainId, no namespaced IDs) |
| `https://indexer.hyperindex.xyz/cfeda9e/v1/graphql` | `mento-v3-monad-mainnet` | Monad-only, to be deleted                             |

These will be deleted once the multichain endpoint is confirmed stable in production.

## Schema

Full schema: [`schema.graphql`](./schema.graphql)

All entities have `chainId: Int! @index` and namespaced IDs since PR #95 (2026-03-27).

## Local Dev

See [`README.md`](./README.md#local-development) for setup instructions.

```bash
pnpm indexer:multichain:codegen
pnpm indexer:multichain:dev
# Hasura: http://localhost:8080 (secret: testing)
```
