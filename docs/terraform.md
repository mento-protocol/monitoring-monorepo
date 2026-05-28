---
title: Terraform Stacks
status: active
owner: eng
canonical: true
last_verified: 2026-05-28
---

# Terraform Stacks

`terraform.stacks.json` is the machine-readable registry for Terraform roots.
Use it instead of inferring ownership from directory names.

| Stack             | Path               | State prefix          | Owns                                                                                                                                      | Plan/apply policy                                                 |
| ----------------- | ------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `platform`        | `terraform/`       | `monitoring-monorepo` | Dashboard Vercel project, Upstash, GCP project/APIs, Metrics Bridge Cloud Run shape, Aegis App Engine/Grafana Agent bootstrap, CI WIF/IAM | Manual plan; human-approved local apply                           |
| `alerts-rules`    | `alerts/rules/`    | `alerts-rules`        | Protocol Grafana alert rules, Grafana folders, global Grafana notification policy, contact points, message templates, mute timings        | PR plan; `main` apply through the `production` GitHub Environment |
| `alerts-delivery` | `alerts/infra/`    | `alerts-infra`        | QuickNode webhooks, alert Cloud Function, Sentry bridge, Slack channel lifecycle, related GCP resources                                   | PR plan; `main` apply through the `production` GitHub Environment |
| `aegis`           | `aegis/terraform/` | `aegis`               | Aegis Grafana dashboard, Aegis folder, Aegis service-health rule group                                                                    | PR plan; `main` apply through the `production` GitHub Environment |

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
```

`pnpm tf validate` without a stack validates all registered stacks with
`terraform fmt -check -recursive`, `terraform init -backend=false`, and
`terraform validate`.

For stacks where `terraform.stacks.json` declares
`ci.apply == "push-main-production-environment"`, local
`pnpm tf apply <stack-id>` is guarded. It runs only when the checkout is on
`main`, the worktree is clean, and `HEAD == origin/main`, unless the operator
passes the deliberate override `--force-local-apply`. The expected safe path is
to merge to `main` and let GitHub Actions apply through the `production`
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

`alerts-rules`, `alerts-delivery`, and `aegis` have CI apply behavior on
`main`, gated by the `production` GitHub Environment. The platform stack remains
manual-plan/manual-apply only.

When one of those CI-applied stacks plans real changes on `main`, the plan job
posts a Slack apply-pending summary before the environment-gated apply job
waits for approval. The summary links back to the merged PR when GitHub can
associate the main commit with a PR, and lists Terraform resource actions by
resource type plus exact resource address. Attribute values are intentionally
omitted from Slack; use the workflow run for the full sanitized plan. The
default destination is `#ci-failures`; set the repository variable
`TERRAFORM_APPLY_SLACK_CHANNEL` to route these summaries to another public
channel.

## Grafana Alert Ownership Migration

The one-time Aegis-to-alerts Grafana state migration was completed on
2026-05-27 and applied successfully. Do not rerun the migration script.

Current ownership:

- `alerts-rules` owns protocol rule groups, protocol folders, the global
  Grafana notification policy, contact points, message templates, and mute
  timings.
- `aegis` owns only the Aegis Grafana folder, Aegis dashboard, and
  `grafana_rule_group.aegis_service_alerts`.

Local gitignored tfvars files must follow the same ownership:

- `alerts/rules/terraform.tfvars`: Grafana token, Slack bot token, and Splunk
  On-Call webhook URL.
- `aegis/terraform/terraform.tfvars`: only `grafana_service_account_token`.

Verify ownership and drift with:

```bash
terraform -chdir=alerts/rules state list | grep -E 'grafana_(rule_group|notification_policy|contact_point|message_template|mute_timing|folder)'
terraform -chdir=aegis/terraform state list | grep grafana_rule_group
pnpm alerts:rules:plan
pnpm aegis:tf:plan
```

Expected result: protocol rule groups and global routing resources appear only
in `alerts-rules`; Aegis state contains the dashboard resources and
`grafana_rule_group.aegis_service_alerts`.
