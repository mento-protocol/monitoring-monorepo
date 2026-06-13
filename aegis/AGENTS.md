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

## RPC Error Handling and Retry Posture

Aegis uses a simple primary-then-fallback retry model with no circuit breaker or backoff:

- **Primary RPC**: the `httpRpcUrl` configured per chain in `config.yaml`. All calls attempt this first.
- **Fallback RPC**: the optional `fallbackHttpRpcUrl` field on a chain config. If a primary call throws, Aegis retries once against the fallback (if configured). If the fallback also throws, or no fallback is configured, the error propagates to the outer handler.
- **No breaker / no backoff**: the retry is a single immediate attempt. There is no exponential backoff, no half-open state, and no per-endpoint health tracking. This is intentional — Aegis metrics are already polled on a schedule; adding backoff would silently extend stale windows.

### `view_call_rpc_errors_total` counter

The counter `view_call_rpc_errors_total` (labels: `contract`, `functionName`, `chain`) increments **only when both the primary and fallback fail** (or when there is no fallback and the primary fails). It does NOT increment on a successful fallback retry.

This lets Grafana distinguish "RPC endpoint was temporarily down but recovered via fallback" (counter stays flat, metric value updates normally) from "both endpoints unreachable" (counter increments, metric goes stale).

Staleness alerting — driven by `isOldestReportExpired` and `view_call_query_duration{status="error"}` — remains the primary on-call signal. `view_call_rpc_errors_total` is a diagnostic aid to identify which endpoint is causing problems.

### Label discipline

Labels on `view_call_rpc_errors_total` are bounded to the same closed set as `view_call_query_duration`: `contract`, `functionName`, and `chain`. These are configuration-driven identifiers with a fixed cardinality. Never add `message`, `error`, or other dynamic string labels — unbounded cardinality breaks Prometheus.

### Adding a fallback RPC to a chain

Add `fallbackHttpRpcUrl` to the chain entry in `config.yaml`:

```yaml
chains:
  - id: celo
    label: celo
    httpRpcUrl: https://forno.celo.org
    fallbackHttpRpcUrl: https://rpc.ankr.com/celo
```

Verify the URL is reachable with a simple `eth_blockNumber` call before committing. Leave testnets and low-metric-count chains as single-endpoint (the fallback field is optional).
