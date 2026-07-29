---
title: Aegis Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-07-29
doc_type: agent-instructions
scope: aegis
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Aegis

> **Architecture decisions** for this package live in [`docs/adr/`](../docs/adr/README.md) (scope: `aegis`) — read the relevant ADR before changing how something here is built; it records the _why_ the code can't.

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
- Keep App Engine deploy changes in sync with `aegis-app-engine.yml` and
  `aegis/bin/deploy.sh`. Direct and nested deploys must retain the explicit
  App Engine source bucket from
  [`ADR 0053`](../docs/adr/0053-explicit-deployment-source-staging.md).
- Terraform changes under `aegis/terraform/` need plan-before-apply discipline; never apply without explicit approval.
- Foundry helper-contract changes require `forge test`.

## Verification

Run `pnpm aegis:lint`, `pnpm aegis:typecheck`, `pnpm --filter @mento-protocol/aegis test:cov`, `pnpm aegis:build`, and Terraform fmt/init/validate for `aegis/terraform` when relevant.

Coverage floors are enforced by `coverageThreshold` in `aegis/package.json`:
statements 85, branches 77, functions 87, lines 85.

## RPC Error Handling

A call tries the chain's primary `httpRpcUrl`, then its optional
`fallbackHttpRpcUrl` once. No backoff, no breaker, no per-endpoint health
tracking, and `retryCount: 0` on both viem clients. That is deliberate: metrics
poll on a schedule, so backoff would silently extend stale windows.

Deterministic failures — reverts, any ABI/encoding/argument error, invalid
address — never retry the fallback and never increment
`view_call_rpc_errors_total`; only transport failure of every configured
endpoint increments it. Keep that counter's labels bounded to `contract`,
`functionName`, and `chain`; never add dynamic strings.

Verify a new `fallbackHttpRpcUrl` under the chain's real concurrent polling
burst — an `eth_blockNumber` smoke test does not expose burst throttling. The
classification rules and config example are in [`README.md`](README.md).
