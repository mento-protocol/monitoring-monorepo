---
title: Alerts Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-05-21
---

# AGENTS.md — Alerts

## Scope

`alerts/` is the domain folder for all alert plumbing. Two independent Terraform stacks live here:

- **`alerts/rules/`** — v3 Grafana metric alert rules + Slack contact points. Grafana provider only. Changes daily (threshold tuning).
- **`alerts/infra/`** — event-driven alert delivery: QuickNode webhooks → Cloud Function (TS) → Discord channels (on-chain multisig events) + Sentry → Slack bridge (app errors) + GCP project. Multi-provider. Changes monthly.

Separate GCS state (`prefix=alerts-rules` for rules, `prefix=alerts-infra` for infra). Keep them separate roots — cadence + blast-radius asymmetry.

## Operating Rules

- **Plan before apply, always.** Never `apply` without explicit human approval.
- **`alerts/infra/` modules talk to live external APIs** (Discord, Sentry, QuickNode). Cosmetic changes can have real side effects.
- **QuickNode state-management hack** in `alerts/infra/onchain-event-listeners/main.tf` is scoped to the current chain via `var.chain_key`. Renaming the `module "onchain_event_listeners"` block in `alerts/infra/main.tf` would silently break the state-rm grep.
- **Cloud Function lockfile**: regenerate `alerts/infra/onchain-event-handler/package-lock.json` with `cd alerts/infra/onchain-event-handler && rm -rf node_modules && npm install --package-lock-only` whenever the pkg's deps change. CI gates lockfile drift in `.github/workflows/alerts-handler.yml`.
- **Mixed Slack + Discord today.** `alerts/rules/` is Slack-first. `alerts/infra/`: Sentry alerts go to Slack via `sentry-bridge`; on-chain multisig events still go to Discord via `discord-channels` + the Cloud Function. A QuickNode → Slack adapter is in BACKLOG.

## Verification

- `pnpm alerts:rules:plan` and `pnpm alerts:infra:plan` — must show 0 changes against existing state.
- `pnpm --filter @mento-protocol/alerts-onchain-event-handler typecheck` and `test` — green on handler changes. Lint/knip are wired but verify they pass too after dep bumps.
- `pnpm agent:quality-gate` for any combined edit — path-aware routing.

For Cloud Function deploy verification, follow `docs/pr-checklists/terraform-cloudrun.md`.

<!--
TODO(test-coverage): the `source_hash` + `var.chain_key` plumbing in
`alerts/infra/onchain-event-listeners/main.tf` (the QuickNode webhook
state-rm dance) is currently only covered by `pnpm alerts:infra:plan`
diffing. Vitest can't reach Terraform-side logic cleanly. If we need
true regression coverage there, options are: (1) a `terraform test`
HCL block exercising the `local-exec` provisioner against a fake
state, or (2) a snapshot test against `terraform plan -out` JSON. Both
are out of scope for the onchain-event-handler test suite — track
separately if drift becomes a real issue.
-->
