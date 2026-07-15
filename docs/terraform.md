---
title: Terraform Stacks
status: active
owner: eng
canonical: true
last_verified: 2026-07-08
---

# Terraform Stacks

`terraform.stacks.json` is the machine-readable registry for Terraform roots.
Use it instead of inferring ownership from directory names.

| Stack                 | Path                         | State prefix          | Owns                                                                                                                                                                                                                     | Plan/apply policy                                                                                                   |
| --------------------- | ---------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `platform`            | `terraform/`                 | `monitoring-monorepo` | Dashboard Vercel project, Upstash, GCP project/APIs, Metrics Bridge Cloud Run shape, Aegis App Engine/Grafana Alloy bootstrap, CI WIF/IAM                                                                                | Manual plan; human-approved local apply                                                                             |
| `alerts-rules`        | `alerts/rules/`              | `alerts-rules`        | Protocol Grafana alert rules + the Aegis service-health rule group, Grafana folders, global Grafana notification policy, contact points, message templates, mute timings                                                 | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `alerts-delivery`     | `alerts/infra/`              | `alerts-infra`        | QuickNode webhooks, alert Cloud Functions, Sentry bridge, Slack channel lifecycle, Splunk On-Call rotation announcements, related GCP resources                                                                          | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `aegis`               | `aegis/terraform/`           | `aegis`               | Aegis Grafana dashboard and Aegis folder                                                                                                                                                                                 | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `governance-watchdog` | `governance-watchdog/infra/` | `governance-watchdog` | Dedicated governance-watchdog GCP project (project factory), the watchdog Cloud Function + source archive, Secret Manager secrets, QuickNode webhooks/filters, Cloud Scheduler health check, log-based monitoring/alerts | PR plan; `main` apply through the `production-infra` GitHub Environment; daily drift plan via `terraform-drift.yml` |

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

`pnpm tf validate` without a stack validates all registered stacks with
`terraform fmt -check -recursive`, `terraform init -backend=false`, and
`terraform validate`.

For stacks where `terraform.stacks.json` declares
`ci.apply == "push-main-production-infra-environment"`, local
`pnpm tf apply <stack-id>` is guarded. It runs only when the checkout is on
`main`, the worktree is clean, and `HEAD == origin/main`, unless the operator
passes the deliberate override `--force-local-apply`. The expected safe path is
to merge to `main` and let GitHub Actions apply through the `production-infra`
Environment approval.

## CI Model

`.github/workflows/infra.yml` asks `scripts/tf-stacks.mjs` which stacks changed
and validates only those stack roots. The workflow summary prints the stack's
state prefix plus its plan/apply policy so reviewers can see whether a PR is
validation-only, manual-plan, or auto-apply eligible.

`.github/workflows/ci.yml` uses the same registry-backed changed-stack
validation inside the required `CI / ci` sentinel. Keep Terraform path routing
in `terraform.stacks.json` rather than duplicating stack ownership in workflow
YAML.

`alerts-rules`, `alerts-delivery`, `aegis`, and `governance-watchdog` have CI
apply behavior on `main`, gated by the `production-infra` GitHub Environment.
Their plan jobs can run for workflow/notifier edits too, but the apply jobs only
become eligible when the stack root changed or a maintainer used
`workflow_dispatch`. The platform stack remains manual-plan/manual-apply only.
`governance-watchdog` lives in its own GCP project and also opts into scheduled
drift detection, where CI runs a read-only plan under `org-terraform`
impersonation without applying changes.

For secret-bearing plan workflows (`alerts-rules.yml`, `alerts-infra.yml`,
`aegis-terraform.yml`, and `governance-watchdog.yml`), same-repo PR plans
intentionally receive validation-safe placeholder `TF_VAR_*` values instead of
production secrets. Push/workflow_dispatch plans and environment-gated apply
jobs keep the real secrets and are the authoritative plan before production
mutation. The Aegis and governance-watchdog PR plans verify Terraform shape and
config diffs with placeholders. The alerts-rules PR plan targets
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
for approval, but only for stack-root changes or explicit manual dispatches.
The summary links back to the merged PR when GitHub can associate the main
commit with a PR, and lists Terraform resource actions by resource type plus
exact resource address. Attribute values are intentionally omitted from Slack;
use the workflow run for the full sanitized plan. The default destination is
`#deploys`; the platform stack manages the repository variable
`TERRAFORM_APPLY_SLACK_CHANNEL` (`terraform_apply_slack_channel` tfvar,
`terraform/github-variables.tf`) — set the tfvar and apply to route these
summaries to another channel. See `docs/notes/slack-github-subscriptions.md`
for the GitHub Slack App subscription, apply-pending summary, queue watcher,
and failure-notifier relationship.

`Terraform Deploy Queue Watch` runs daily and warns in the same Terraform apply
Slack channel when one of the production Terraform deploy workflows has been
queued or pending for at least 60 minutes with zero started jobs. The watcher is
observer-only: it does not share the deploy workflows' `*-deploy` concurrency
groups, cancel runs, approve environments, or change apply ordering.

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
run `terraform-drift.yml` before closing the drift issue.

## Platform GitHub Actions secrets and variables

The platform stack mirrors repo-level GitHub Actions secrets and variables on
`monitoring-monorepo` (`terraform/github-secrets.tf`,
`terraform/github-variables.tf`). Their values come from the platform stack's
gitignored, operator-held `terraform/terraform.tfvars` (never committed) or from
other platform resources; each secret-mirroring resource is `count`-gated on its
value being set, so plan/apply succeed while a value is unset. The platform
stack is manual-plan / manual-apply (`pnpm infra:plan`, then a human-approved
`pnpm tf apply platform`), not a CI `production-infra` apply.

Sentry triage/autofix pipeline (ADR 0036), provisioned by issue #1276:

- `SENTRY_TRIAGE_TOKEN` — READ-ONLY Sentry internal-integration token
  (`sentry_triage_token` tfvar). Read scopes only; no write scopes (Phase-1
  trust boundary). `count`-gated.
- `CLAUDE_CODE_OAUTH_TOKEN` — Claude Max OAuth token from `claude setup-token`
  (`claude_code_oauth_token` tfvar), for `anthropics/claude-code-action@v1`.
  `count`-gated. Adopts the pre-existing live secret shared with
  `.github/workflows/claude.yml`: the first apply overwrites (rotates) the live
  value, and the resource carries `prevent_destroy` so emptying the tfvar fails
  the plan loudly instead of silently breaking the Claude PR automation.
- `SENTRY_TRIAGE_ENABLED` — kill-switch **variable** (`sentry_triage_enabled`
  tfvar), default `"false"`. The scheduled workflows stay inert until it is
  `"true"`.

The human token-provisioning and activation steps are in the operator runbook in
[`docs/notes/sentry-triage-pipeline.md`](notes/sentry-triage-pipeline.md).

## GitHub Environment Setup

Pre-merge requirement for the production-environment split in issue #762:
repo admins must create both environments in Settings -> Environments before
merging the workflow change that first references them. GitHub auto-creates a
missing environment on first workflow use with no protection rules, so
`production-infra` must already have required reviewers, self-review allowed
for the required reviewer, administrator bypass disabled, and the protected-`main` branch restriction
before any Terraform-changing commit can land on `main`. The Terraform apply
workflows also verify this configuration before cloud authentication so an
accidentally auto-created or bypassable environment fails closed before
`terraform apply`.

Repo admins should keep exactly two production GitHub Environments for this
repo's Actions workflows:

- `production-infra`: used by Terraform apply jobs in `alerts-infra.yml`,
  `alerts-rules.yml`, `aegis-terraform.yml`, and `governance-watchdog.yml`.
  Copy the required reviewers from the old `production` environment, allow
  self-review for the required reviewer, disable administrator bypass, and
  limit deployment branches to protected `main`.
- `production-services`: used by routine service deploy jobs such as
  `metrics-bridge.yml` and `aegis-app-engine.yml`. Limit deployment branches to
  protected `main`, but leave required reviewers unset by default so green
  `main` deploys do not require an extra human approval.

The old `Production` migration-shim environment was removed on 2026-06-17 after
workflow references drained. Do not recreate it. Do not move or recreate secrets
with CLI commands; any environment-scoped secret changes must go through the
owning IaC or a documented repo-admin settings change.

## Grafana Alert Ownership Migration

The one-time Aegis-to-alerts Grafana state migration was completed on
2026-05-27 and applied successfully. Do not rerun the migration script.

On 2026-06-02 the Aegis **service-health** rule group
(`grafana_rule_group.aegis_service_alerts`) was relocated from the `aegis`
stack into `alerts-rules` (issue #706). Because Terraform `moved {}` blocks do
not cross state backends, this was an import-then-state-rm move: PR1 added the
resource to `alerts/rules/rules-aegis-service.tf` and the operator
`terraform import`ed the existing Grafana object into `alerts-rules` state
(0-diff) before approving that apply; PR2 removed it from `aegis/terraform` and
the operator `terraform state rm`'d it from `aegis` state (no Grafana delete)
before approving that apply. The Grafana object and its firing state were
preserved throughout; the Aegis folder stays in the `aegis` stack.

Current ownership:

- `alerts-rules` owns protocol rule groups, the Aegis service-health rule
  group (`grafana_rule_group.aegis_service_alerts`), protocol folders, the
  global Grafana notification policy, contact points, message templates, and
  mute timings.
- `aegis` owns only the Aegis Grafana folder and Aegis dashboard.

Local gitignored tfvars files must follow the same ownership:

- `alerts/rules/terraform.tfvars`: Grafana token, Slack bot token, and Splunk
  On-Call webhook URL.
- `alerts/infra/terraform.tfvars`: Sentry token, Slack bot token, QuickNode
  credentials, GitHub PAT, and Splunk On-Call API ID/key plus Slack channel
  and usergroup IDs for the on-call announcer.
- `aegis/terraform/terraform.tfvars`: only `grafana_service_account_token`.
- `governance-watchdog/infra/terraform.tfvars`: org/billing ids, GitHub PAT
  (`github_token`) for mirroring drift-workflow repo secrets, plus the
  notification and webhook secrets (Discord/Telegram credentials, QuickNode
  API key + security token, x-auth token, VictorOps webhook URL); template in
  `governance-watchdog/infra/terraform.tfvars.example`, real file stays
  operator-held and gitignored.

Verify ownership and drift with:

```bash
terraform -chdir=alerts/rules state list | grep -E 'grafana_(rule_group|notification_policy|contact_point|message_template|mute_timing|folder)'
terraform -chdir=aegis/terraform state list | grep grafana_rule_group
pnpm alerts:rules:plan
pnpm aegis:tf:plan
```

Expected result: protocol rule groups, global routing resources, and
`grafana_rule_group.aegis_service_alerts` appear only in `alerts-rules`; the
`aegis` state contains only the Aegis folder + dashboard resources (the
`grep grafana_rule_group` against `aegis` returns nothing).
