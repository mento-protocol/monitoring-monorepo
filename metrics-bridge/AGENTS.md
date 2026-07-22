---
title: Metrics Bridge Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
doc_type: agent-instructions
scope: metrics-bridge
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Metrics Bridge

> **Architecture decisions** for this package live in [`docs/adr/`](../docs/adr/README.md) (scope: `metrics-bridge`) — read the relevant ADR before changing how something here is built; it records the _why_ the code can't.

## Scope

`metrics-bridge/` exports Hasura/Envio data, rebalance probes, and isolated
external peg observations as Prometheus gauges for Grafana alerting.

## Operating Rules

- Keep `/health` as the health endpoint. Cloud Run v2 reserves `/healthz` at the frontend.
- Treat GraphQL failures and RPC probe failures as separate error channels. Do not collapse them into one boolean.
- Hasura is shared with the public dashboard; the isolation trigger and mitigation playbook live in `docs/notes/hasura-isolation-trigger.md`.
- New Prometheus labels must have bounded cardinality. Never expose tx hashes, user addresses, or pool-specific free text as unbounded labels. Narrow exception: `last_oracle_update_url` is intentionally carried only on the oracle timestamp/expiry gauges so Grafana can link Slack "last update" text to the exact report transaction; do not copy that pattern to broad pool labels or user/high-frequency dimensions.
- Every polling loop must have a timeout, visible error metric/state, and a deterministic retry posture.
- Keep the external peg loop isolated from the primary Hasura loop and
  `/health`. Missing or invalid peg policy configuration must degrade only peg
  coverage; it must not stop the service or stale the existing pool gauges.
- The image carries `peg-registry.json` because it is service-local source
  identity and topology. Never bake `alerts/rules/peg-thresholds.json` into the
  image: page-affecting policy comes only from the protected runtime artifact.
- Rebalance probe changes must update unit tests and the mutation baseline when the changed branch is part of the current mutation target.
- `PoolLiquidityStrategy` is authoritative for rebalance-probe cardinality.
  Use `Pool.rebalancerAddress` only for the explicit missing-schema rollout
  fallback. A pool is blocked only when every active strategy returns a
  confirmed blocked result; skip/transport outcomes are unconfirmed, not
  blocked.

## Verification

Run `pnpm --filter @mento-protocol/metrics-bridge lint`, `typecheck`, `test`,
and `build`. For Cloud Run/runtime changes, apply
`docs/pr-checklists/terraform-cloudrun.md`.

## Peg policy bootstrap

`PEG_POLICY_URL` is optional raw configuration for the IaC-published,
versioned peg-policy artifact. When it is absent, the peg loop remains
intentionally dormant until the protected artifact plane is provisioned. A
blank or malformed value belongs to the peg loop's bounded error channel; it
must not abort startup or affect the primary Hasura poller.

Policy versions are content-addressed: the final 32 lowercase hexadecimal
characters must match the canonical policy-content SHA-256 prefix. Canonical
JSON recursively sorts object keys by Unicode code point and preserves array
order. Do not reuse a version prefix or hand-edit its suffix; runtime and CI
verify the binding and require a rollover to retain the exact base-branch
active policy as `previous`. ACK-clear `previous` before a second active
rollover; CI and the runtime reject chained rollovers.

The service validates and fetches thresholds at runtime. The Docker image
contains `metrics-bridge/peg-registry.json` at the path resolved by the
compiled registry loader, but it never contains `peg-thresholds.json`. Policy
publication and activation remain behind the alerts-rules production-infra
gate described by [ADR 0044](../docs/adr/0044-peg-thresholds-gated-rules-plane.md).

## RPC overrides

Rebalance simulation uses full-node RPCs rather than Envio HyperRPC. Production
defaults exist for Celo (`RPC_URL_42220`), Monad (`RPC_URL_143`), and Polygon
(`RPC_URL_137`); each environment variable overrides the corresponding public
default. Monad testnet still requires an explicit `RPC_URL_10143`.
