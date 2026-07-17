---
title: Envio Indexer Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-07-17
doc_type: agent-instructions
scope: indexer-envio
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Envio Indexer

Read the `indexer-envio` records in
[`docs/adr/`](../docs/adr/README.md) before changing architecture. Package
topology, current contracts/entities, commands, environment setup, local-stack
invariants, and contract-add/promotion procedures live in
[`README.md`](README.md).

## What This Is

One Envio HyperIndex project indexes Ethereum reserve yield, Celo and Monad v3
pools, the Celo v2 Broker path, and Mento Liquity/CDP state. Production behavior
is defined by `config.multichain.mainnet.yaml`, `schema.graphql`, and the loaded
handler graph—not by historical plans.

## Before Opening PRs

For schema changes, entity/field additions, degraded RPC behavior, or any
indexer data that propagates into Hasura/UI, apply
[`../docs/pr-checklists/stateful-data-ui.md`](../docs/pr-checklists/stateful-data-ui.md).
Cross-layer/stateful work is incomplete until writers, readers, generated
types, rollout behavior, and representative browser/query tests agree.

## Key Files

- `config.multichain.mainnet.yaml` / `config.multichain.testnet.yaml` — hosted
  and testnet contract/event configuration.
- `schema.graphql` — entity contract exposed by Hasura.
- `src/EventHandlers.ts` — required handler entry point; every handler module
  must be reachable through a side-effect import here.
- `src/contractAddresses.ts` and `config/deployment-namespaces.json` — contract
  resolution plus the hosted-build namespace mirror.
- `config/protocolActors.json` — only protocol actors not derivable from pool or
  contract metadata.
- `abis/` and `scripts/generateAbis.mjs` — vendored ABI allowlist and documented
  hand-vendored exceptions.

## Commands and Local Development

Use the root `pnpm indexer:*` commands or package scripts documented in the
README. After changing schema, config, entry-point imports, or handler module
reachability, run `pnpm indexer:codegen`; after dashboard queries change, also
run `pnpm dashboard:codegen`.

The wrapper reads `.env`, not named legacy env files. `.env.example` is the
variable reference. Never set generic `ENVIO_RPC_URL` in multichain mode; use
per-chain overrides, and ensure fallback RPCs cover the full archive/replay
window. Local Hasura must stay on port 8080, only one `generated` Docker stack
may run at a time, and codegen must go through the wrapper so the Postgres
healthcheck is re-applied.

## Contract Types

The production config and README enumerate indexed contracts. The load-bearing
Broker rule is: Celo v2 `Swap` rows carry `routedViaV3Router` based on
`tx.to == Routerv300`, allowing dashboard volume to exclude sibling rows already
counted through `VirtualPool.Swap`. Preserve that denormalization when changing
the v2/v3 volume path; see
[ADR 0017](../docs/adr/0017-broker-denormalization-volume-dedup.md).

## Dependencies

`@mento-protocol/contracts` owns published addresses and ABIs. Two mirrors are
deliberate because Envio hosted builds can run outside the pnpm workspace:

- Keep `config/deployment-namespaces.json` synchronized with
  `../shared-config/deployment-namespaces.json`.
- Keep `src/feeToken.ts:buildKnownTokenMeta` synchronized with the applicable
  policy in `../shared-config/src/tokens.ts`; the indexer additionally excludes
  mocks and requires decimals at its call site.

Do not replace these with a `workspace:*` dependency without a dedicated
deploy-path change; see
[ADR 0013](../docs/adr/0013-vendored-shared-config-mirror.md). ABI refresh and
address-drift rules are in
[ADR 0015](../docs/adr/0015-abi-vendoring-and-address-drift-gate.md).

## Handler and Data Invariants

Before changing handlers, RPC effects, heal stages, IDs, counters, or related
tests, apply
[`../docs/pr-checklists/indexer-handler-invariants.md`](../docs/pr-checklists/indexer-handler-invariants.md).
It owns the collision-resistant ID rule, entity rollups, trading-time units,
bounded caches, median freshness, partial-heal retry coordination, downstream
predicate/query audit, Vitest RPC mocks, and env parsing.

Also apply the shared recurring-review rules for file-size limits, multichain
enumeration, Hasura row caps, and effect-layer boundaries:
[`../docs/pr-checklists/recurring-review-patterns.md`](../docs/pr-checklists/recurring-review-patterns.md).

## Liquity / CDP

Read
[`../docs/notes/liquity-monitoring-invariants.md`](../docs/notes/liquity-monitoring-invariants.md)
before changing Liquity handlers, schema, queries, or KPIs. The deployed
ActivePool does not emit debt updates; `systemDebt` is coordinated between
open-trove transition deltas and observed DefaultPool redistribution deltas.
Never replace it with cached `activePoolDebt + defaultPoolDebt`. Rebalance
redemptions are a subset discriminated by transaction target, not a distinct
event type.

## Observability

Indexer failures use structured `context.log.error` events with the
`<area>.<event>` convention and flow through Envio logs to Loki/Grafana. Do not
add Sentry to handlers; see
[ADR 0018](../docs/adr/0018-indexer-observability-loki.md).
