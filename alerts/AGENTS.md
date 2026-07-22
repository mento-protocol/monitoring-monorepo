---
title: Alerts Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-05-21
doc_type: agent-instructions
scope: alerts
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Alerts

> **Architecture decisions** for this package live in [`docs/adr/`](../docs/adr/README.md) (scope: `alerts`) — read the relevant ADR before changing how something here is built; it records the _why_ the code can't.

## Scope

`alerts/` is the domain folder for all alert plumbing. Two independent Terraform stacks live here:

- **`alerts/rules/`** — protocol Grafana metric alert rules + global Grafana notification policy/contact points/templates/mute timings. Grafana provider only. Changes daily (threshold tuning).
- **`alerts/infra/`** — event-driven alert delivery: QuickNode webhooks → Cloud Function (TS) → Slack channels (on-chain multisig events) + Sentry → Slack bridge (app errors) + Splunk On-Call rotation announcer → Slack #eng / @support-engineer + GCP project. Multi-provider. Changes monthly.

Separate GCS state (`prefix=alerts-rules` for rules, `prefix=alerts-infra` for infra). Keep them separate roots — cadence + blast-radius asymmetry. Stack ownership is registered in `terraform.stacks.json` and summarized in `docs/terraform.md`.

Operator runbooks: [`alerts/infra/README.md`](infra/README.md) for event-driven
delivery and [`alerts/rules/README.md`](rules/README.md) for Grafana rules and
routing.

## Operating Rules

- **Plan before apply, always.** Never `apply` without explicit human approval.
- **`alerts/infra/` modules talk to live external APIs** (Slack, Sentry, and QuickNode). Cosmetic changes can have real side effects.
- **QuickNode state-management hack** in `alerts/infra/onchain-event-listeners/main.tf` is scoped to the current chain via `var.chain_key`. Renaming the `module "onchain_event_listeners"` block in `alerts/infra/main.tf` would silently break the state-rm grep.
- **Cloud Function lockfiles**: Cloud Build deploys `alerts/infra/onchain-event-handler/` and `alerts/infra/oncall-announcer/` as standalone source roots, so keep each package-local `pnpm-lock.yaml` in sync when its deps change. Regenerate with `cd <function-dir> && pnpm install --lockfile-only --lockfile-dir .`. Each package-local `pnpm-workspace.yaml` mirrors the root release-age guard and carries standalone Cloud Build overrides; keep it in the function source hash. CI installs from package-local locks before function checks, and supply-chain CI audits/lints root plus both function lockfiles.
- **Slack delivery is the active path.** `alerts/rules/` owns Grafana Slack contact points plus Splunk routing for page-severity protocol and Aegis service-health alerts. `alerts/infra/`: Sentry alerts go to Slack via `sentry-bridge`; on-chain multisig events route to Slack via `slack-channels` + the Cloud Function; Splunk On-Call rotations route to Slack via `oncall-announcer` and reconcile @support-engineer.
- **GCP operational failures route to `#alerts-infra`.** `alerts/infra/monitoring.tf` creates the Slack notification channel with the existing bot token unless an existing same-project channel ID is explicitly supplied. The on-call announcer policy matches failed Cloud Scheduler attempts directly so function 5xx, IAM, timeout, and unreachable-target failures cannot leave `@support-engineer` stale without a notification.
- **Annotation queries must stay evaluable.** In Grafana alert rules,
  annotation/helper queries can propagate `NoData` through the whole rule even
  when the base alert query is firing. Do not let annotation-only series
  disappear while the base alert can still fire; prefer a label-matched
  fallback or sentinel series, then branch Slack templates on the sentinel.

## Verification

- `pnpm tf validate alerts-rules` / `pnpm tf validate alerts-delivery` for local validation.
- `pnpm alerts:rules:plan` and `pnpm alerts:infra:plan` — must show 0 changes against existing state unless the PR intentionally changes the stack.
- `pnpm --filter @mento-protocol/alerts-onchain-event-handler typecheck` and `test:coverage` — green on handler changes. Lint/knip are wired but verify they pass too after dep bumps.
- `pnpm --filter @mento-protocol/alerts-oncall-announcer typecheck` and `test:coverage` — green on on-call announcer changes. Lint/knip are wired too.
- `bash alerts/infra/scripts/fix-webhook-state.test.sh` — required when changing the shared QuickNode state-ID parser, repair tool, or listener replacement provisioner.
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
