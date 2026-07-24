---
title: Indexer Deployment Reference
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
doc_type: reference
scope: indexer-envio
review_interval_days: 90
garden_lane: package-readmes-reference
---

# Indexer Deployment Reference

## Deployment Model

Single multichain mainnet indexer (Ethereum reserve-yield `1`, Celo Mainnet
`42220`, Monad `143`, and Polygon `137`) on the Envio Cloud `mento` project (org
`mento-protocol`). Ethereum reserve-yield handlers are event-only; the
historical sUSDS onBlock heartbeat is not registered in the hosted indexer.

This file documents only facts that stay true across redeployments. For live
sync state and the latest deployment currently visible to Envio, run:

```bash
pnpm deploy:indexer:status          # latest visible deployment status
pnpm deploy:indexer:status --json   # machine-readable
```

Use these commands or the Envio console for provider-owned details such as the
current deployment, sync state, and service tier.

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

`indexer-envio/config.multichain.mainnet.yaml` — covers Ethereum (1)
sUSDS/stETH reserve-yield accounting, Celo (42220), Monad (143), and Polygon
(137). Polygon is live at the static production endpoint; future replacements
still require the normal deploy, sync verification, semantic verification, and
promotion workflow.

Git release branch: `envio` — push to this branch to trigger a redeployment.

## Schema

Full schema: [`schema.graphql`](./schema.graphql)

All cross-chain entities have `chainId` fields and namespaced IDs since PR #95 (2026-03-27). Internal marker/helper entities may only carry the chain dimension needed by their lookup path.

## Local Dev

See [`README.md`](./README.md#local-development) for setup instructions.

```bash
pnpm indexer:codegen
pnpm indexer:dev
pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test
# Hasura: http://localhost:8080 (secret: testing)
```
