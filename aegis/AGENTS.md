---
title: Aegis Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-05-20
---

# AGENTS.md — Aegis

## Scope

`aegis/` polls configured on-chain view calls and exposes Prometheus metrics for Grafana dashboards and alerts.

## Operating Rules

- Treat `config.yaml` as production monitoring policy.
- New metrics need local startup verification and bounded Prometheus labels.
- Keep App Engine deploy changes in sync with `aegis-app-engine.yml` and `aegis/bin/deploy.sh`.
- Terraform changes under `aegis/terraform/` need plan-before-apply discipline; never apply without explicit approval.
- Foundry helper-contract changes require `forge test`.

## Verification

Run `pnpm aegis:lint`, `pnpm aegis:typecheck`, `pnpm aegis:test`, `pnpm aegis:build`, and Terraform fmt/init/validate for `aegis/terraform` when relevant.
