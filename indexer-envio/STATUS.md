# Indexer Deployment Reference

## Deployment Model

Single multichain mainnet indexer (Celo Mainnet `42220` + Monad `143` +
Ethereum Mainnet `1` sUSDS reserve-yield events) on the Envio Cloud `mento`
project (org `mento-protocol`), Production Medium tier.

This file documents only facts that stay true across redeployments. For live
sync state and the currently promoted deployment, run:

```bash
pnpm deploy:indexer:status          # latest deployment status
pnpm deploy:indexer:status --json   # machine-readable
```

## GraphQL Endpoint

The multichain indexer uses a **static** production endpoint (hash does not change on redeploy):

```text
https://indexer.hyperindex.xyz/2f3dd15/v1/graphql
```

Stored as `NEXT_PUBLIC_HASURA_URL` in Vercel project settings and as the `hasura_url` Terraform variable default.

> Only update these if the `mento` project is deleted and recreated (which would issue a new endpoint hash).
> Redeployments to the same project preserve the static endpoint.

## Pool ID Format

Pool IDs are namespaced as `{chainId}-{address}` (e.g. `42220-0x02fa...`, `143-0xd0e9...`).
All child entities (`poolId` FKs) follow the same format.

## Config File

`indexer-envio/config.multichain.mainnet.yaml` — covers both Celo (42220) and Monad (143).

Git release branch: `envio` — push to this branch to trigger a redeployment.

## Legacy Projects

The old single-network Envio projects still exist as project records but have no active deployments:

| Project                  | Current role                         |
| ------------------------ | ------------------------------------ |
| `mento-v3-celo-mainnet`  | Legacy project record, no deployment |
| `mento-v3-monad-mainnet` | Legacy project record, no deployment |
| `mento-v3-celo-sepolia`  | Legacy project record, no deployment |
| `mento-v3-monad-testnet` | Legacy project record, no deployment |

## Schema

Full schema: [`schema.graphql`](./schema.graphql)

All cross-chain entities have `chainId` fields and namespaced IDs since PR #95 (2026-03-27). Internal marker/helper entities may only carry the chain dimension needed by their lookup path.

## Local Dev

See [`README.md`](./README.md#local-development) for setup instructions.

```bash
pnpm indexer:codegen
pnpm indexer:dev
# Hasura: http://localhost:8080 (secret: testing)
```
