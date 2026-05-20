---
title: Metrics Bridge Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-05-20
---

# AGENTS.md — Metrics Bridge

## Scope

`metrics-bridge/` exports Hasura/Envio data and rebalance probes as Prometheus gauges for Grafana alerting.

## Operating Rules

- Keep `/health` as the health endpoint. Cloud Run v2 reserves `/healthz` at the frontend.
- Treat GraphQL failures and RPC probe failures as separate error channels. Do not collapse them into one boolean.
- New Prometheus labels must have bounded cardinality. Never expose tx hashes, user addresses, or pool-specific free text as unbounded labels.
- Every polling loop must have a timeout, visible error metric/state, and a deterministic retry posture.
- Rebalance probe changes must update unit tests and the mutation baseline when the changed branch is part of the current mutation target.

## Verification

Run `pnpm --filter @mento-protocol/metrics-bridge lint`, `typecheck`, and `test`. For Cloud Run/runtime changes, apply `docs/pr-checklists/terraform-cloudrun.md`.
