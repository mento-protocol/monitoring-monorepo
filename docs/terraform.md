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

For secret-bearing plan workflows (`alerts-rules.yml`, `alerts-infra.yml`,
`aegis-terraform.yml`, and `governance-watchdog.yml`), eligible same-repo human
PR plans intentionally receive validation-safe placeholder `TF_VAR_*` values
instead of production secrets. Fork, Dependabot, and `sentry-autofix/*` plans
are skipped. Push/workflow_dispatch plans and environment-gated apply jobs keep
the real secrets and are the authoritative plan before production mutation.
The Aegis and governance-watchdog PR plans verify Terraform shape and config
diffs with placeholders. The alerts-rules PR plan targets
`terraform_data.pr_plan_secretless_guard` plus the non-secret rule groups that
route through the global notification policy and do not directly depend on
Slack/Splunk contact points. It still skips contact points, notification
policies, and rule groups with direct `notification_settings`; trusted
main/apply plans remain the source of truth for refreshed Grafana diffs and the
full notification graph. The alerts-delivery PR plan is also narrower by design:
it runs init/validate plus a targeted secretless plan for
`terraform_data.pr_plan_secretless_guard`. The handler module is not yet safe to
target from PRs because it depends on Slack channel outputs and
placeholder-backed Secret Manager versions; the sentinel also covers Sentry,
Slack, QuickNode, and GitHub provider/resource surfaces that perform
authenticated plan-time checks and cannot run with dummy credentials.
Reviewers should treat the main-branch re-plan behind `production-infra` as the
source of truth for alerts-rules and alerts-delivery full-stack diffs,
third-party provider changes, and all secret value changes.
See [`docs/notes/terraform-secret-strategy-2026-07.md`](notes/terraform-secret-strategy-2026-07.md)
for the current secret classification and migration posture.

Routine service deploy workflows use the separate `production-services` GitHub
Environment. That environment records deploy history and scopes production
secrets, but should not require routine manual approval; PR review plus
required CI before merge is the approval path for normal service rollouts.

When one of those CI-applied stacks plans real changes on `main`, the plan job
posts a Slack apply-pending summary before the environment-gated apply job waits
for approval, but only for stack-owned deployment-input changes or explicit
manual dispatches.
The summary links back to the merged PR when GitHub can associate the main
commit with a PR, and lists Terraform resource actions by resource type plus
exact resource address. Attribute values are intentionally omitted from Slack;
use the workflow run for the full sanitized plan. The default destination is
`#deploys`; the platform stack manages the repository variable
`TERRAFORM_APPLY_SLACK_CHANNEL` (`terraform_apply_slack_channel` tfvar,
`terraform/github-variables.tf`) — set the tfvar and apply to route these
summaries to another channel. See
[`docs/notes/slack-github-subscriptions.md`](notes/slack-github-subscriptions.md)
for the GitHub Slack App subscription, apply-pending summary, queue watcher,
and failure-notifier relationship.

`Terraform Deploy Queue Watch` runs daily and warns in the same Terraform apply
Slack channel when one of the production Terraform deploy workflows has been
queued, pending, requested, or waiting on `main` for at least 60 minutes with
zero started jobs. The watcher is observer-only: it does not share the deploy
workflows' `*-deploy` concurrency groups, cancel runs, approve environments, or
change apply ordering.

If a post-merge Terraform deploy workflow stays `pending` with no jobs, start
from the watcher alert or inspect that workflow's run queue directly before
waiting on the current run. Older `waiting` or `pending` runs in the same deploy
concurrency group can block the current merge commit. Confirm the older runs are
obsolete, cancel them, then watch the current run until both plan and apply reach
a terminal state. If approval was granted before the apply job existed, GitHub
can require a fresh `production-infra` approval after the plan creates the apply
job.

If an older queued or waiting run is intentionally approved because it carries
needed state reconciliation, keep watching the same deploy workflow until every
queued `main` run reaches a terminal state. Later queued jobs can pass the
`production-infra` gate without an obvious second prompt, so do not call a drift
issue fixed from the first successful apply alone. Verify the live resource and
dispatch `terraform-drift.yml` from `main` before closing the drift issue.

## Platform GitHub Actions secrets and variables

The manual-apply platform stack owns the repo-level Actions mirrors declared in
`terraform/github-secrets.tf` and `terraform/github-variables.tf`. Values come
from platform resources or the gitignored, operator-held tfvars described by
[`terraform/terraform.tfvars.example`](../terraform/terraform.tfvars.example). Some
resource-derived mirrors are unconditional; optional provider keys and Sentry
credentials are `count`-gated on non-empty inputs. Clearing a count-gated input
can therefore plan deletion of the live Actions secret or variable.

Review every planned secret deletion. `CLAUDE_CODE_OAUTH_TOKEN` is the only
current mirror with `prevent_destroy` because it adopts a shared credential
used outside the Sentry pipeline. Do not assume the other optional mirrors have
that protection.

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
auto-create an unprotected environment when a workflow first references a
missing name, so create any future environment with its reviewed protection
before merging that reference.

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

Use each stack's maintained input template instead of copying a partial list
from this overview:

- [`terraform/terraform.tfvars.example`](../terraform/terraform.tfvars.example)
- [`alerts/rules/terraform.tfvars.example`](../alerts/rules/terraform.tfvars.example)
- [`alerts/infra/terraform.tfvars.example`](../alerts/infra/terraform.tfvars.example)
- [`governance-watchdog/infra/terraform.tfvars.example`](../governance-watchdog/infra/terraform.tfvars.example)
- `aegis/terraform` currently requires only
  `grafana_service_account_token`; see
  [`aegis/terraform/variables.tf`](../aegis/terraform/variables.tf).

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
