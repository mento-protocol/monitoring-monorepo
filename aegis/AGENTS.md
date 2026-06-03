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
- For Mento stable-token metric aliases, Prometheus metric names, and Grafana
  legends, use canonical current symbols (`USDm`, `EURm`, `BRLm`, `XOFm`,
  `PHPm`, etc.). Legacy aliases such as `cXXX`, `PUSO`, and `eXOF` should not
  be used for new Aegis stable-token metrics unless an external contract/config
  key explicitly requires them.
- Keep App Engine deploy changes in sync with `aegis-app-engine.yml` and `aegis/bin/deploy.sh`.
- Terraform changes under `aegis/terraform/` need plan-before-apply discipline; never apply without explicit approval.
- Foundry helper-contract changes require `forge test`.

## Verification

Run `pnpm aegis:lint`, `pnpm aegis:typecheck`, `pnpm --filter @mento-protocol/aegis test:cov`, `pnpm aegis:build`, and Terraform fmt/init/validate for `aegis/terraform` when relevant.

Aegis Jest coverage floors were measured on 2026-06-03 after adding config,
metrics, query, and watcher specs: statements 87.91, branches 79.23, functions
89.61, lines 87.97. The enforced floor keeps a two-point variance margin at
statements 85, branches 77, functions 87, and lines 85.
