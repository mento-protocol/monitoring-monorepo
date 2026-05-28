---
title: Terraform Stacks
status: active
owner: eng
canonical: true
last_verified: 2026-05-27
---

# Terraform Stacks

`terraform.stacks.json` is the machine-readable registry for Terraform roots.
Use it instead of inferring ownership from directory names.

| Stack             | Path               | State prefix          | Owns                                                                                                                                      | Plan/apply policy                                                 |
| ----------------- | ------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `platform`        | `terraform/`       | `monitoring-monorepo` | Dashboard Vercel project, Upstash, GCP project/APIs, Metrics Bridge Cloud Run shape, Aegis App Engine/Grafana Agent bootstrap, CI WIF/IAM | Manual plan; human-approved apply                                 |
| `alerts-rules`    | `alerts/rules/`    | `alerts-rules`        | Protocol Grafana alert rules, Grafana folders, global Grafana notification policy, contact points, message templates, mute timings        | PR plan; `main` apply through the `production` GitHub Environment |
| `alerts-delivery` | `alerts/infra/`    | `alerts-infra`        | QuickNode webhooks, alert Cloud Function, Sentry bridge, Slack channel lifecycle, related GCP resources                                   | PR plan; `main` apply through the `production` GitHub Environment |
| `aegis`           | `aegis/terraform/` | `aegis`               | Aegis Grafana dashboard, Aegis folder, Aegis service-health rule group                                                                    | PR plan; `main` apply through the `production` GitHub Environment |

## Commands

```bash
pnpm tf list
pnpm tf validate <stack-id>
pnpm tf plan <stack-id>
pnpm tf apply <stack-id>
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
