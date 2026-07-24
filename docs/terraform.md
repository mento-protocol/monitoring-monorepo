---
title: Terraform Stacks
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Terraform Stacks

`terraform.stacks.json` is the machine-readable registry for Terraform roots.
Use it instead of inferring ownership from directory names.

| Stack                 | Path                         | State prefix          | Owns                                                                                                                                                                                                              | Plan/apply policy                                                                                                   |
| --------------------- | ---------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `platform`            | `terraform/`                 | `monitoring-monorepo` | Dashboard Vercel project, Upstash, GCP project/APIs, Metrics Bridge Cloud Run shape, Aegis App Engine/Grafana Alloy bootstrap, separated CI WIF/IAM identities, and platform-owned repo Actions secrets/variables | Manual plan; human-approved local apply                                                                             |
| `alerts-rules`        | `alerts/rules/`              | `alerts-rules`        | Protocol Grafana alert rules + Aegis service-health and testnet-health rule groups, Grafana folders, global Grafana notification policy, contact points, message templates, mute timings                          | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `alerts-delivery`     | `alerts/infra/`              | `alerts-infra`        | QuickNode webhooks, alert Cloud Functions, Sentry bridge, Slack channel lifecycle, Splunk On-Call rotation announcements, related GCP resources, and stack-local trusted-main refresh grants                      | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `aegis`               | `aegis/terraform/`           | `aegis`               | Aegis Grafana dashboard and Aegis folder                                                                                                                                                                          | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `governance-watchdog` | `governance-watchdog/infra/` | `governance-watchdog` | Dedicated governance-watchdog GCP project, Cloud Function/source archive, Secret Manager, QuickNode webhook creation, scheduler, monitoring, alerts, and stack-local trusted-main refresh grants                  | PR plan; `main` apply through the `production-infra` GitHub Environment; daily drift plan via `terraform-drift.yml` |

## Commands

```bash
pnpm tf list
pnpm tf validate <stack-id>
pnpm tf plan <stack-id>
pnpm tf apply <stack-id> [--force-local-apply]
```

Existing aliases remain:

```bash
pnpm infra:plan
pnpm alerts:rules:plan
pnpm alerts:infra:plan
pnpm aegis:tf:plan
pnpm gov-watchdog:tf:plan
```

`pnpm tf validate` without a stack validates all registered stacks. It checks
formatting for tracked and non-ignored untracked native Terraform sources, then
runs `terraform init -backend=false` and `terraform validate`. Gitignored
operator-held `*.tfvars` files are deliberately outside the source-format check.

For stacks where `terraform.stacks.json` declares
`ci.apply == "push-main-production-infra-environment"`, local
`pnpm tf apply <stack-id>` is guarded. It runs only when the checkout is on
`main`, the worktree is clean, and `HEAD == origin/main`, unless the operator
passes the deliberate override `--force-local-apply`. The expected safe path is
to merge to `main` and let GitHub Actions apply through the `production-infra`
Environment approval.

## CI Model

`.github/workflows/infra.yml` uses coarse YAML path filters to admit a run. The
required `.github/workflows/ci.yml` sentinel runs on every PR and routes
internally. Its change filter and `scripts/tf-stacks.mjs` use
`terraform.stacks.json` to classify changed stacks and validate only their
registered roots. The registry remains the ownership source of truth, but a new
`changedPathPatterns` entry must also reach the infra admission filter and the
CI internal filter until
[#1501](https://github.com/mento-protocol/monitoring-monorepo/issues/1501)
replaces that duplication with enforced parity.

`alerts-rules`, `alerts-delivery`, `aegis`, and `governance-watchdog` have CI
apply behavior on `main`, gated by the `production-infra` GitHub Environment.
Their plan jobs can run for workflow/notifier edits too, but the apply jobs only
become eligible when stack-owned deployment inputs changed or a maintainer used
`workflow_dispatch`. The platform stack remains manual-plan/manual-apply only.
`terraform-drift.yml` runs a daily plan-only check for all four stacks. During
the identity bootstrap, its Google-provider legs still use the legacy
write-capable deployer. A separate routing PR moves trusted-main plans and
scheduled drift to the refresh chain, retaining the legacy path for rollback
until live proof and drain checks pass.

Secret-bearing workflows use validation-safe placeholder `TF_VAR_*` values or
guarded targets for eligible same-repo human PR plans. Fork, Dependabot, and
`sentry-autofix/*` plans are skipped. Trusted push/dispatch plans and the
environment-gated apply jobs retain the real secrets and are authoritative for
full-stack, third-party-provider, and secret-value diffs. In particular,
alerts-rules and alerts-delivery PR plans are intentionally partial; do not
interpret them as full production plans.
See [`docs/notes/terraform-secret-strategy-2026-07.md`](notes/terraform-secret-strategy-2026-07.md)
for the exact placeholder and target boundaries.

For a real `main` plan, the workflow posts a secretless Slack action summary
before its apply waits for approval. GitHub evaluates Environment protection
before starting the apply job, so the operator approves the commit and this
earlier plan. The current apply job then creates and applies a later plan; its
output was not available at approval time. Treat the gap as an explicit drift
window.

`Terraform Deploy Queue Watch` warns when a production Terraform workflow has
had no job start for at least 60 minutes; it observes only and never cancels or
approves runs. Inspect the whole workflow queue: cancel a predecessor only
after confirming it is obsolete; otherwise let its reconciliation finish.
Approval given before the apply job existed may need repeating after the plan
creates that job. Follow every queued `main` run to a terminal state because
later runs can pass the gate without an obvious second prompt. Never close
drift from the first successful apply alone: verify the live resource and
dispatch `terraform-drift.yml` from `main`. That workflow does not cover the
manual-apply `platform` stack; recheck a `stack:platform` repo-setting drift
issue (e.g. the default workflow-token permission) by dispatching
`platform-settings-drift.yml` from `main` instead. Channel routing and
notification boundaries live in
[`docs/notes/slack-github-subscriptions.md`](notes/slack-github-subscriptions.md).

## Terraform CI identities

[ADR 0047](adr/0047-separated-terraform-ci-identities.md) owns the four lanes:
routine deploy, state-only same-repo PR plan, read-only trusted-`main` refresh,
and Environment-bound production apply. All three WIF providers bind repository
slug plus immutable ID `1172025835`; apply also binds protected `main` and the
`production-infra` subject, while refresh binds an exact `workflow_ref`
allowlist. The bootstrap must not route workflows through either refresh
variable.

Trusted-main plans use `-lock=false` and curated non-basic readers. Never add
basic `roles/viewer`; keep object and secret payload access limited to state,
deployment-source objects, and managed secrets. After routing, prove
alerts-delivery and governance-watchdog with live full-refresh plans and add
only permissions named by provider failures.

ADR 0047 also selects the final no-artifact apply contract: make a private plan
after approval, run fail-closed policy over its JSON, then apply those exact
bytes. Issue #1576 owns the dual-run migration. Until it lands, the current
apply-time re-plan and drift window remain in force.

## Identity bootstrap, routing cutover, and authority removal

Follow ADR 0047's full procedure:

1. Merge the bootstrap, cancel its queued infrastructure applies, then review
   and explicitly approve a local platform plan/apply from clean current
   `main`.
2. Re-run alerts-delivery and governance-watchdog, verify the new apply path,
   and retain the routine-deployer Token Creator grant for rollback.
3. Land the separate refresh-routing PR, run the live plans above, drain every
   old/proof run, and audit both paths.
4. Only then land and explicitly apply the final legacy-authority removal.

Do not create the peg-policy project or bucket until step 4 is applied, all
runs drain, and the IAM audit proves the legacy path is gone.

## Platform GitHub Actions secrets and variables

The manual-apply platform stack owns repository Actions mirrors in
`terraform/github-secrets.tf` and `terraform/github-variables.tf`. Clearing an
optional input can plan deletion; inspect each one. It also owns
`GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER`,
`GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT`,
`GCP_TERRAFORM_REFRESH_WORKLOAD_IDENTITY_PROVIDER`, and
`GCP_TERRAFORM_REFRESH_SERVICE_ACCOUNT`. Workflows read these as `vars`; never
replace them with manual secrets or use the refresh selectors before routing.
Only `CLAUDE_CODE_OAUTH_TOKEN` currently has `prevent_destroy`; inspect every
planned mirror deletion.
Sentry credential routing lives in
[`docs/notes/sentry-triage-pipeline.md`](notes/sentry-triage-pipeline.md).

## GitHub Environments

Keep two production Environments. `production-infra` has a required reviewer,
self-review allowed, admin bypass disabled, and protected-branch deployment; its
workflows verify that state before cloud auth. With one maintainer this is
operator acknowledgement, not independent or exact-plan review. [ADR
0029](adr/0029-ci-apply-production-infra-gate.md) records the decision against a
same-owner `CODEOWNERS` gate; revisit PR approval, latest-push approval, and
disabled Environment self-review when a second active maintainer exists.

`production-services` records routine deploys from protected `main` without a
reviewer. Never recreate retired `Production`/`production` names or manage
Environment secrets outside their owning IaC/integration path. A new workflow
reference can auto-create an unprotected Environment, so establish its
protection before merging the reference.

## Grafana Alert Ownership

The Aegis-to-alerts state migration is complete; do not rerun its import/state
removal procedure. Current ownership is:

- `alerts-rules` owns protocol rule groups, Aegis service-health and
  testnet-health rule groups, protocol folders, the global Grafana notification
  policy, contact points, message templates, and mute timings.
- `aegis` owns only the Aegis Grafana folder and Aegis dashboard.

Use each stack's maintained `terraform.tfvars.example` (or
`aegis/terraform/variables.tf`) instead of copying inputs from this overview.

Verify ownership and drift with:

```bash
terraform -chdir=alerts/rules state list | grep -E 'grafana_(rule_group|notification_policy|contact_point|message_template|mute_timing|folder)'
terraform -chdir=aegis/terraform state list | grep grafana_rule_group
pnpm alerts:rules:plan
pnpm aegis:tf:plan
```

Expected result: protocol rule groups, global routing resources,
`grafana_rule_group.aegis_service_alerts`, and
`grafana_rule_group.aegis_testnet_health` appear only in `alerts-rules`; the
`aegis` state contains only the Aegis folder + dashboard resources (the
`grep grafana_rule_group` against `aegis` returns nothing).
