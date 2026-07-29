---
title: Metrics Bridge Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-07-29
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

Apply
[`docs/pr-checklists/stateful-data-ui.md`](../docs/pr-checklists/stateful-data-ui.md)
when GraphQL or metric-state changes propagate across the indexer, bridge, or
downstream alerts/dashboard.

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
  Never log or expose its bearer token.
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

`PEG_POLICY_URL` and `PEG_POLICY_AUTH_MODE` are paired raw configuration for
the IaC-published, versioned peg-policy artifact; when both are absent the peg
loop stays intentionally dormant. A blank, malformed, missing, or mismatched
pair belongs to the peg loop's bounded error channel: it degrades peg coverage
only, never startup or the primary Hasura poller.

Production runs `gcp-metadata` against the generation-pinned GCS endpoint that
platform Terraform derives from a reviewed source literal — never an
env-supplied URL or auth mode. `none` is code-only for local or test artifacts
and needs the `allowUnauthenticatedPolicy` option; environment configuration
cannot enable it.

Policy versions are content-addressed, and a rollover must retain the exact
prior active version as `previous`; CI and the runtime verify that binding and
reject a second rollover until an ACK cleanup sets `previous` back to `null`.
Do not reuse a version prefix or hand-edit its suffix. Private transport,
generation pinning, project placement, and the activation boundary are fixed by
[ADR 0054](../docs/adr/0054-same-project-peg-policy-artifact.md); the runtime
identity's IAM belongs to
[`terraform/AGENTS.md`](../terraform/AGENTS.md).

## RPC overrides

Rebalance simulation uses full-node RPCs rather than Envio HyperRPC. Production
defaults exist for Celo (`RPC_URL_42220`), Monad (`RPC_URL_143`), and Polygon
(`RPC_URL_137`); each environment variable overrides the corresponding public
default. Monad testnet still requires an explicit `RPC_URL_10143`.
