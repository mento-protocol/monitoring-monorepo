---
title: Two alert planes — Grafana metric thresholds and event-driven delivery
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: repo-wide
date: 2026-04
---

# ADR 0004 — Two alert planes: Grafana metric thresholds and event-driven delivery

**Status:** Accepted (Apr–May 2026), in force.
**Scope:** repo-wide (alerting)

## Context

Two fundamentally different things need alerting. Some signals are **continuous
metrics** crossing thresholds (pool health, oracle staleness, TCR/ICR, rebalancer
liveness, service health). Others are **discrete on-chain events** that must fire
exactly once when they happen (multisig actions, governance events). One
mechanism cannot serve both well: thresholds need a metrics store and evaluation;
events need a webhook that reacts to a specific log.

## Decision

Run **two alert planes**:

1. **Metric-threshold plane** — protocol data becomes Prometheus/Grafana metrics
   (via Aegis for v2 and metrics-bridge for v3) and Grafana alert rules evaluate
   thresholds and route to Slack/Splunk On-Call.
2. **Event-driven plane** — QuickNode webhooks → Cloud Function → Slack for
   on-chain multisig events, a Sentry→Slack bridge for app errors, and an on-call
   rotation announcer; governance-watchdog delivers to Discord/Telegram.

## Alternatives considered

- **One plane for everything** — rejected: polling for discrete events is laggy and
  lossy; threshold logic bolted onto webhooks is fragile.
- **Alert directly off the database** — rejected: the DB has no evaluation/routing
  engine; that is exactly why metrics-bridge exists (ADR 0027).

## Consequences

- Alert plumbing lives under `alerts/` in two Terraform roots split by cadence and
  blast radius (`alerts/rules` daily; `alerts/infra` monthly) — see ADR 0028.
- Grafana routing is **per-rule**, not a single channel; Slack templates use the
  Alertmanager funcmap, not sprig.

## Evidence

- metrics-bridge PR #153 (2026-04-17); alerts stack integration PR #514 (2026-05-25); event delivery CI PR #558.
- [`alerts/AGENTS.md`](../../alerts/AGENTS.md), [`SPEC.md`](../../SPEC.md) §Alerting.
