---
title: Metrics Bridge Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-05-20
doc_type: agent-instructions
scope: metrics-bridge
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Metrics Bridge

> **Architecture decisions** for this package live in [`docs/adr/`](../docs/adr/README.md) (scope: `metrics-bridge`) — read the relevant ADR before changing how something here is built; it records the _why_ the code can't.

## Scope

`metrics-bridge/` exports Hasura/Envio data and rebalance probes as Prometheus gauges for Grafana alerting.

## Operating Rules

- Keep `/health` as the health endpoint. Cloud Run v2 reserves `/healthz` at the frontend.
- Treat GraphQL failures and RPC probe failures as separate error channels. Do not collapse them into one boolean.
- Hasura is shared with the public dashboard; the isolation trigger and mitigation playbook live in `docs/notes/hasura-isolation-trigger.md`.
- New Prometheus labels must have bounded cardinality. Never expose tx hashes, user addresses, or pool-specific free text as unbounded labels. Narrow exception: `last_oracle_update_url` is intentionally carried only on the oracle timestamp/expiry gauges so Grafana can link Slack "last update" text to the exact report transaction; do not copy that pattern to broad pool labels or user/high-frequency dimensions.
- Every polling loop must have a timeout, visible error metric/state, and a deterministic retry posture.
- Rebalance probe changes must update unit tests and the mutation baseline when the changed branch is part of the current mutation target.

## Verification

Run `pnpm --filter @mento-protocol/metrics-bridge lint`, `typecheck`, and `test`. For Cloud Run/runtime changes, apply `docs/pr-checklists/terraform-cloudrun.md`.
