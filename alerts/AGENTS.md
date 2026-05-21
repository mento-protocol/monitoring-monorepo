---
title: Alerts Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-05-21
---

# AGENTS.md — Alerts

## Scope

`alerts/` is the domain folder for all alert plumbing. Two **independent** Terraform stacks live here:

- **`alerts/rules/`** — v3 Grafana metric alert rules + Slack contact points. Grafana provider only. Changes daily (threshold tuning).
- **`alerts/infra/`** — event-driven alert delivery: QuickNode webhooks → Cloud Function (TS) → Discord channels + Sentry → Discord bridge + GCP project. Multi-provider (Google/Discord/Sentry/QuickNode). Changes monthly.

The two stacks have **no data dependencies** and **separate GCS state** (`prefix=monorepo-alerts` for rules, `prefix=alerts` for infra). Don't try to merge them into one root — research-validated as bad architecture (cadence + blast-radius asymmetry, distinct provider sets).

## Operating Rules

- **Plan before apply, always.** `pnpm alerts:rules:plan` or `pnpm alerts:infra:plan` first; never `apply` without explicit human approval.
- **`alerts/infra/` modules talk to live external APIs** (Discord, Sentry, QuickNode). Cosmetic changes can have real side effects (channel renames, Sentry alert recreation, QuickNode webhook re-registration).
- **QuickNode state-management hack lives in `alerts/infra/onchain-event-listeners/main.tf`** — a `local-exec` provisioner shells out to `terraform state list/rm` because QuickNode webhooks don't support PUT/PATCH. It's scoped to the current chain instance via `var.chain_key`; renaming the `module "onchain_event_listeners"` block would silently break that grep.
- **`safe-abi.json` is committed to `alerts/infra/onchain-event-handler/`** (canonical location). The listener reads it via `${path.root}/onchain-event-handler/safe-abi.json`. Don't duplicate.
- **Cloud Function lockfile**: `alerts/infra/onchain-event-handler/package-lock.json` exists so Cloud Build's `npm ci` locks deps. The package is ALSO a pnpm workspace member for local dev. If you bump deps locally, regenerate the lockfile with `cd alerts/infra/onchain-event-handler && npm install --package-lock-only`.
- **Discord-only today, Slack pending.** `alerts/infra/` is Discord-only (Slack adapter is a BACKLOG.md item). `alerts/rules/` is already Slack-first. Don't add new Discord-only paths to `rules/`.
- **No Hasura `_aggregate` queries** in Grafana rules — same monorepo rule (hosted Hasura disables them).
- **Bounded label cardinality** in any new gauge or rule label — no tx hashes, no user addresses, no pool-specific free text as unbounded labels.

## Verification

- `pnpm alerts:rules:plan` — must show 0 changes when run on an unmodified `alerts/rules/` against existing state.
- `pnpm alerts:infra:plan` — must show 0 changes when run on an unmodified `alerts/infra/` against existing state.
- `pnpm --filter @mento-protocol/alerts-onchain-event-handler typecheck && lint && test` — green on `onchain-event-handler/` changes.
- `pnpm agent:quality-gate` for any combined edit — the path-aware gate routes per-stack.

For Cloud Function deploy verification, follow `docs/pr-checklists/terraform-cloudrun.md`.
