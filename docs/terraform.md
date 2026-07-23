---
title: Terraform Stacks
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Terraform Stacks

`terraform.stacks.json` is the machine-readable registry for Terraform roots.
Use it instead of inferring ownership from directory names.

| Stack                 | Path                         | State prefix          | Owns                                                                                                                                                                                         | Plan/apply policy                                                                                                   |
| --------------------- | ---------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `platform`            | `terraform/`                 | `monitoring-monorepo` | Dashboard Vercel project, Upstash, GCP project/APIs, Metrics Bridge Cloud Run shape, Aegis App Engine/Grafana Alloy bootstrap, CI WIF/IAM, and platform-owned repo Actions secrets/variables | Manual plan; human-approved local apply                                                                             |
| `alerts-rules`        | `alerts/rules/`              | `alerts-rules`        | Protocol Grafana alert rules + Aegis service-health and testnet-health rule groups, Grafana folders, global Grafana notification policy, contact points, message templates, mute timings     | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `alerts-delivery`     | `alerts/infra/`              | `alerts-infra`        | QuickNode webhooks, alert Cloud Functions, Sentry bridge, Slack channel lifecycle, Splunk On-Call rotation announcements, related GCP resources                                              | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `aegis`               | `aegis/terraform/`           | `aegis`               | Aegis Grafana dashboard and Aegis folder                                                                                                                                                     | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `governance-watchdog` | `governance-watchdog/infra/` | `governance-watchdog` | Dedicated governance-watchdog GCP project, Cloud Function/source archive, Secret Manager, QuickNode webhook creation, scheduler, monitoring, and alerts                                      | PR plan; `main` apply through the `production-infra` GitHub Environment; daily drift plan via `terraform-drift.yml` |

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

`.github/workflows/infra.yml` and the required `.github/workflows/ci.yml`
sentinel use coarse YAML path filters to admit a run. After admission,
`scripts/tf-stacks.mjs` uses `terraform.stacks.json` to classify changed stacks
and validate only their registered roots. The registry remains the ownership
source of truth, but a new `changedPathPatterns` entry must also reach both
workflow admission filters until
[#1501](https://github.com/mento-protocol/monitoring-monorepo/issues/1501)
replaces that duplication with enforced parity.

`alerts-rules`, `alerts-delivery`, `aegis`, and `governance-watchdog` have CI
apply behavior on `main`, gated by the `production-infra` GitHub Environment.
Their plan jobs can run for workflow/notifier edits too, but the apply jobs only
become eligible when stack-owned deployment inputs changed or a maintainer used
`workflow_dispatch`. The platform stack remains manual-plan/manual-apply only.
`terraform-drift.yml` also runs a daily read-only plan for all four CI-applied
stacks under `org-terraform` impersonation. It never applies changes.

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
before its apply waits for approval. `Terraform Deploy Queue Watch` warns when
a production Terraform workflow has had no job start for at least 60 minutes;
it observes only and never cancels or approves runs. Inspect the whole workflow
queue: cancel a predecessor only after confirming it is obsolete; otherwise let
its reconciliation finish. Approval given before the apply job existed may need
repeating after the plan creates that job. Follow every queued `main` run to a
terminal state because later runs can pass the gate without an obvious second
prompt. Never close drift from the first successful apply alone: verify the live
resource and dispatch `terraform-drift.yml` from `main`. Channel routing and
notification boundaries live in
[`docs/notes/slack-github-subscriptions.md`](notes/slack-github-subscriptions.md).

## Platform GitHub Actions secrets and variables

The manual-apply platform stack owns repository Actions mirrors in
`terraform/github-secrets.tf` and `terraform/github-variables.tf`; values come
from platform resources or operator-held tfvars. Optional mirrors are
`count`-gated, so clearing an input can plan deletion. Review every planned
secret deletion: only `CLAUDE_CODE_OAUTH_TOKEN` currently has
`prevent_destroy`.

The Sentry triage, projection, autofix, and archive credentials and their three
kill switches are routed by
[`docs/notes/sentry-triage-pipeline.md`](notes/sentry-triage-pipeline.md). Keep
that runbook and the Terraform resources aligned rather than duplicating the
full inventory here.

## GitHub Environments

Keep exactly two production GitHub Environments for this repository:

- `production-infra`: used by Terraform apply jobs in `alerts-infra.yml`,
  `alerts-rules.yml`, `aegis-terraform.yml`, and `governance-watchdog.yml`.
  It must have required reviewers, self-review allowed for the required
  reviewer, administrator bypass disabled, and deployment branches limited to
  protected `main`. Terraform apply workflows verify this before cloud
  authentication and fail closed if protection drifts.
- `production-services`: used by routine service deploy jobs such as
  `metrics-bridge.yml` and `aegis-app-engine.yml`. Limit deployment branches to
  protected `main`, but leave required reviewers unset by default so green
  `main` deploys do not require an extra human approval.

Do not recreate the retired `Production`/`production` environments. GitHub can
auto-create an unprotected environment for a new workflow reference, so review
and create any future environment protection before merging that reference.

Never move or recreate environment secrets with CLI commands. Use the owning
IaC or documented owning integration; if neither exists, stop and establish an
IaC path before changing the secret.

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
