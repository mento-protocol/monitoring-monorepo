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

- **`alerts/rules/`** — protocol Grafana metric alert rules + global Grafana notification policy/contact points/templates/mute timings. Grafana provider only. Changes daily (threshold tuning).
- **`alerts/infra/`** — event-driven alert delivery: QuickNode webhooks → Cloud Function (TS) → Slack channels (on-chain multisig events) + Sentry → Slack bridge (app errors) + GCP project. Legacy Discord resources may remain during post-Slack-cutover cleanup. Multi-provider. Changes monthly.

Separate GCS state (`prefix=alerts-rules` for rules, `prefix=alerts-infra` for infra). Keep them separate roots — cadence + blast-radius asymmetry. Stack ownership is registered in `terraform.stacks.json` and summarized in `docs/terraform.md`.

## Operating Rules

- **Plan before apply, always.** Never `apply` without explicit human approval.
- **`alerts/infra/` modules talk to live external APIs** (Slack, Sentry, QuickNode, and legacy Discord while retained). Cosmetic changes can have real side effects.
- **QuickNode state-management hack** in `alerts/infra/onchain-event-listeners/main.tf` is scoped to the current chain via `var.chain_key`. Renaming the `module "onchain_event_listeners"` block in `alerts/infra/main.tf` would silently break the state-rm grep.
- **Cloud Function lockfile**: Cloud Build deploys `alerts/infra/onchain-event-handler/` as its own source root, so keep its package-local `pnpm-lock.yaml` in sync when handler deps change. Regenerate with `cd alerts/infra/onchain-event-handler && pnpm install --lockfile-only --lockfile-dir .`. The package-local `pnpm-workspace.yaml` mirrors the root release-age guard and carries standalone Cloud Build overrides; keep it in the function source hash. CI installs from the package-local lock before handler checks, and supply-chain CI audits/lints both root and handler lockfiles.
- **Slack delivery with legacy Discord state today.** `alerts/rules/` owns Grafana Slack contact points plus legacy Discord/Splunk routing for protocol and Aegis service-health alerts. `alerts/infra/`: Sentry alerts go to Slack via `sentry-bridge`; on-chain multisig events route to Slack via `slack-channels` + the Cloud Function. Legacy Discord resources can remain in Terraform state until a post-soak cleanup PR removes them cleanly.

## Verification

- `pnpm tf validate alerts-rules` / `pnpm tf validate alerts-delivery` for local validation.
- `pnpm alerts:rules:plan` and `pnpm alerts:infra:plan` — must show 0 changes against existing state unless the PR intentionally changes the stack.
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
